# Security

## Reporting a problem

Please report security problems through GitHub's private vulnerability reporting, not in a public issue:

1. Go to the [Security tab](https://github.com/Umerrrdo/nosnitch/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it and which version you used.

The report stays private between you and the maintainers until a fix is out.

## What counts

nosnitch reads compose files and env files that you point it at, and writes one file, `compose.nosnitch.override.yml`. It makes no network calls unless you pass `--update`. Things worth a private report:

- A crafted compose file, env file or downloaded database that makes nosnitch write outside the override file, run code or leak file contents.
- A network call in default mode.
- A problem in how `--update` downloads or validates the database.

A database entry that is wrong or out of date is not a security problem, even though it matters. Open a normal issue or a pull request for that.

## Supported versions

Fixes go into the latest release only.
