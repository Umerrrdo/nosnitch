# Add an app in 5 minutes

The database is one YAML file per app in `db/apps/`. Adding an app means adding one file.

## The one rule

**Never invent anything.** Every claim in an entry must come from the project's official docs or its source code, and the URL goes under `sources`. If you cannot confirm a detail, leave that field out and set `verified: false`. Wrong privacy advice is worse than none.

Blog posts, forum answers and AI summaries are not sources. Use them to find the official page, then cite that page.

## Steps

1. Create `db/apps/<slug>.yaml`. The slug is lowercase with dashes and must match the file name.
2. Fill it in using the template below.
3. Run:

   ```sh
   npm install
   npm run build:db   # validates every entry and regenerates db/index.json
   npm test
   ```

4. Commit your YAML file and the regenerated `db/index.json`, then open a pull request. Say in the description where in the source each claim comes from if it is not obvious.

## Template

```yaml
name: Example App
slug: example-app
images:
  - exampleorg/example-app          # Docker Hub: no registry prefix
  - ghcr.io/exampleorg/example-app  # other registries: full name
telemetry_default: "on"             # on | off | partial | unknown (keep the quotes around on and off)
destinations:
  - telemetry.example.com           # only hostnames the project documents
what_is_sent: One honest sentence, only if documented.
disable:
  - type: env
    name: EXAMPLE_TELEMETRY_DISABLED
    value: "true"
sources:
  - https://docs.example.com/self-hosting/telemetry
verified_on: "2026-11-11"           # the day you checked the sources
verified: true
```

## Fields

| Field | Required | Notes |
| --- | --- | --- |
| `name`, `slug` | yes | |
| `images` | yes | No tag, no digest. `*` matches any run of characters. Write Docker Hub images without `docker.io/`. |
| `telemetry_default` | yes | `on`, `off`, `partial` (some of it is on) or `unknown` (not documented). |
| `destinations` | no | Hostnames only. Leave it out if the project does not name them. |
| `what_is_sent` | no | One sentence, taken from the docs. |
| `still_sent` | no | What keeps going out after the opt-out, if the docs say so. |
| `disable` | yes | List of methods, see below. May be empty if there is no opt-out. |
| `fixed_in` | no | Version where the default became off. |
| `sources` | yes | At least one `https://` URL. |
| `verified_on` | yes | ISO date. |
| `verified` | yes | `true` only if every field is backed by a source. |
| `notes` | no | Caveats worth knowing. |

## Disable methods

```yaml
disable:
  # An environment variable. nosnitch detects it and --fix writes it.
  - type: env
    name: EXAMPLE_TELEMETRY_DISABLED
    value: "true"
    accepted_values: ["1", "yes"]     # optional: other values that also work
    alternatives:                     # optional: other variables that do the same
      - name: DO_NOT_TRACK
        value: "1"
    note: Set it on every container.  # optional

  # A variable that stops other outbound calls (update checks and so on), not telemetry.
  # Shown by `nosnitch check`, never required for an OK, never written by --fix.
  - type: env
    name: EXAMPLE_UPDATE_CHECK
    value: "false"
    optional: true

  # A command-line flag. nosnitch detects it in command and entrypoint.
  - type: flag
    flag: --no-telemetry

  # A key in a config file. Shown as a manual step.
  - type: config_file
    path: config/config.yaml
    key: telemetry.enabled
    value: "false"

  # Anything else, such as a UI toggle.
  - type: manual
    instructions: Turn off "Usage statistics" under Settings > General.
```

Values are always strings, so quote `"true"`, `"false"` and numbers.

## Fixing an entry

If an entry is wrong or out of date, edit the file, update `verified_on`, add the source that shows the change, and open a pull request. If you find a problem but cannot confirm the right answer, open an issue or set `verified: false` in a pull request.

## Code changes

`npm test` builds the TypeScript in `src/` and runs the tests in `test/`. The tests run the CLI with every network API blocked, so a change that adds a network call outside `--update` fails.
