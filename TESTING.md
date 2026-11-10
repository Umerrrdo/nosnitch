# Testing

What was tested before the first release, what broke, and what was changed. Dated 2026-11-11.

The aim was simple: someone who has never seen nosnitch installs it, points it at their compose file, and nothing goes wrong.

## Summary

| Area | Result |
| --- | --- |
| Fresh install with `npx github:Umerrrdo/nosnitch` on Windows | Works, including from a folder with spaces in its name |
| Docker image, built from the Dockerfile | Works, including with `--network none` |
| 32 official compose files from real projects | All scan, fix and blocklist cleanly after the fixes below |
| 7 of the maintainer's own compose files | All scan cleanly (no known apps in them) |
| Every `--fix` override checked with `docker compose config` | Accepted every time, variable applied to the right service |
| Automated tests | 92 pass on Windows (Node 22) and on Linux (Node 20 and 22) |
| Network calls in default mode | None, shown three ways (see below) |

## How to repeat it

```sh
npm install
npm test                  # 92 tests: build, then node --test
npm run validate:db       # every entry against db/schema.json
npm run check:sources     # every source URL (uses the network)
docker build -t nosnitch .
docker run --rm --network none -v "$PWD/test/fixtures:/work:ro" nosnitch scan example-compose.yml
```

## 1. Fresh install

- Cloned the repository into an empty temp folder and ran the tool with `npx github:Umerrrdo/nosnitch`, with a cleared npm cache. This was done before the package was on npm and before the project was renamed from its working title, phonehome. `scan`, `scan --fix`, a re-scan with the override, `blocklist --format pihole`, `check` and `list` all worked.
- Repeated it from a folder named `ph npx 2` to cover a path with spaces.
- Built the Docker image and ran `scan`, `scan` with no file name, and `scan --fix` against a mounted folder.

README corrections that came out of this:

- The Docker section explains `--user` on Linux for `--fix`. Without it the override file would belong to the container's user.

## 2. Real compose files

Official files were downloaded from each project's own repository and scanned as they are, with no edits:

Activepieces, Appsmith, Appwrite, Chatwoot, Coder, Documenso, Firezone, Gitea, Grafana with Loki, Grafana with Prometheus, Hasura, Home Assistant, Immich, Kodus, Langfuse, Lightdash, Mattermost, n8n, Nextcloud, Novu, OneCLI, Open WebUI, OpenSEO, Outline, Paperless-ngx, Plausible, PostHog, Rocket.Chat, Sentry self-hosted, Supabase, Umami, Uptime Kuma.

For each file a script ran `scan`, `scan --fix --json`, `blocklist` in all three formats and `check` on every image, and compared the results with the database. It also checked that `check` and `scan` agree on every image.

Seven compose files from other projects on the test machine were scanned as well. They were copied to a temp folder first, so nothing was written into those projects.

### What broke, and the fix

| Problem | Where it showed up | Fix |
| --- | --- | --- |
| Crash: "Excessive alias count indicates a resource exhaustion attack" | Sentry's compose file reuses YAML anchors hundreds of times | Raised the YAML alias limit |
| Nested variable defaults were left unresolved, such as `${A:-${B:-4}}` | Langfuse | Rewrote variable interpolation to handle nesting and every Compose operator |
| The official Langfuse compose file was not recognised at all | It uses `docker.langfuse.com/langfuse/langfuse`, the database only had the Docker Hub name | Added both registry names |
| Images with an unset variable turned into nonsense like `mattermost/:` or `-node:latest` | Mattermost, n8n, PostHog, Sentry | The name is now shown as written. If only the tag is unknown the app is still matched. If the name itself is unknown, nosnitch says which service it is and asks for the variable to be set |
| One warning per service for the same missing `env_file`, each with a long absolute path | Chatwoot, Kodus, OneCLI and others | One warning per file, listing the services that use it |
| 40 warnings that `extends` is not followed | Appwrite, PostHog | `extends` is now followed, in the same file and across files |
| `include:` was ignored silently | Found while reading the Compose spec against the code | `include` is now followed |
| An optional `env_file` (`required: false`) produced a warning | Compose spec | No warning for optional files |
| The table became very wide with image digests | Grafana with Loki, Immich | Digests are shortened to 8 characters in the table. JSON keeps them whole |
| Sentry's services were not recognised | The official file builds the image locally as `sentry-self-hosted-local` | Added that name to the Sentry entry |

## 3. Validating the fix

For every file where `--fix` wrote an override, the test ran:

```sh
docker compose -f <file> -f compose.nosnitch.override.yml config --format json --no-interpolate
```

and then read the merged result to confirm each variable landed on the service it was meant for. Docker Compose 2 (Docker 29.8.2) accepted all of them: 16 files, 22 variables. A second scan with both files then reported every one of those services as disabled.

`--no-interpolate` was used because most official files need a `.env` that only exists after you configure the project.

## 4. Edge cases

Each of these has a test in [test/edge.test.mjs](test/edge.test.mjs).

| Case | Behaviour |
| --- | --- |
| Windows line endings, in the compose file and the env file | Read correctly |
| UTF-8 BOM, in the compose file and the env file | Read correctly |
| Empty file, or whitespace only | Exit 2: "is empty", with what a compose file needs |
| Invalid YAML | Exit 2, with the line and column and a pointer to `docker compose config` |
| A file with no services | Exit 2: "No services found", asks if it is a compose file |
| A YAML file that is not a compose file (a list, a string) | Exit 2: "does not look like a Compose file" |
| A service with an empty definition | Listed as having no image, no crash |
| `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` | All found when no file is given. `compose.yaml` wins, as in Docker Compose |
| A folder passed instead of a file | The compose file inside it is used |
| `include:` as a string, as `path:`, missing, and in a loop | Followed. A missing file is a warning. A loop ends |
| `extends:` in the same file, in another file, missing, and in a loop | Followed. The extending service can override the base |
| `profiles:` | Every service is scanned, whichever profile it is in |
| Values in every quoting style Compose accepts | All counted |
| Literal quotes or spaces inside a value, such as `- KEY="false"` in list form | Not counted, because the app receives the quotes. A warning explains it and gives the correct line |
| env file values with quotes, spaces around `=`, comments, `export` | Read the way Compose reads them |
| Other variables containing spaces, quotes, `=` and unicode | Do not disturb parsing |
| A variable passed through from the host with no value | Not counted, with an explanation |
| Paths with spaces, for the compose file, the env file and the override | Work. The printed `docker compose` command quotes them |
| Windows backslash paths, on the command line and inside the compose file | Work, also on Linux and macOS for paths inside the file |
| A very large file, 3000 services | Scans in well under 10 seconds |
| A file that reuses one anchor 400 times | Works |
| Digests, with and without a tag | Matched. `fixed_in` still compares the tag |
| Private registries and mirrors | Not matched. A hint names the entry it looks like |
| Only the optional variables set | Still flagged. `--fix` adds just the missing one |
| Telemetry off but update checks on | OK, with the rest listed as optional |
| Some services opted out, some not, one with the wrong value | Only the rest are fixed. The override replaces the wrong value |
| Only manual opt-outs left | `--fix` says why no file was written |

## 5. Platforms

- Windows 11, Node 22: full suite, by hand and through `npm test`.
- Linux (Alpine containers), Node 20.20 and Node 22.23: full suite. One test is skipped there because it passes a backslash path on the command line, which only means something on Windows.
- Node 18: nosnitch stops with "nosnitch needs Node 20 or newer" instead of failing in some odd way.
- CI now runs the suite on Ubuntu, Windows and macOS, each with Node 20 and 22. A separate job builds the Docker image, scans inside it with `--network none`, writes an override from inside the container and checks it with `docker compose config`.

Not done by hand: macOS, and Node 20 on Windows. Both are covered by the CI matrix, and the CI run for these changes passed on all six combinations, along with the Docker job and the source URL check.

## 6. No network in default mode

Shown three ways:

1. **Test with every network API blocked.** The tests start the CLI with a preload that replaces `net`, `dns`, `http`, `https` and `fetch` with functions that print a marker and throw. `scan`, `check`, `list` and `--help` all run without tripping it. A control test proves the preload does catch a real attempt, and another proves `--update` is the one path that trips it.
2. **Docker with `--network none`.** The container has no network interface at all. `scan` and `scan --fix` both work and give the same output.
3. **Reading the code.** `fetch` appears once, in `src/update.ts`, which is only loaded when `--update` is passed.

## 7. Error messages

Every error now has two parts: what went wrong, and what to do. No stack trace is printed unless `--debug` is passed. An unexpected error (a bug) also prints one line and asks for a report with `--debug`.

Covered by tests: unknown command, a file name typed where the command should be ("Did you mean: nosnitch scan ..."), unknown option, `check` with no image, `check` given a compose file, an unknown blocklist format, `--format` with no value, file not found, a folder with no compose file, no file given and none found, an override that cannot be written, a failed `--update`, and running on an old Node.

One wording change: a file with no services used to produce a warning and exit 0. It is now exit 2, because it is almost always the wrong file.

## Database checks

- All 45 entries validate against the schema.
- 57 of 58 source URLs respond. The one that does not is Firezone's docs host, which did not resolve. That entry is marked unverified for that reason.
- Image names for the new entries were taken from each project's official compose file or docs where one exists. Several older entries were confirmed the same way while scanning the real files (Documenso, Chatwoot, Coder, Hasura, Lightdash, Activepieces, Appsmith, OpenSEO, Novu, Langfuse, Immich, n8n, Grafana).

## Known limits

- nosnitch reads the compose file, not the running containers. A variable set some other way (a Docker secret, a mounted config file, an orchestrator) is not seen.
- Apps whose opt-out is a config file or a UI switch stay flagged, because nosnitch cannot look inside them.
- `fixed_in` only helps when the tag is a full version number. `latest`, `release` or `v3` stay flagged.
- `docker compose config` was run without interpolation, so it proves the override is valid and merges onto the right service, not that the whole project starts.