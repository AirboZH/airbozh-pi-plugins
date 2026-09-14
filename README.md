# airbozh-pi-plugins

Pi coding-agent plugins. Install this git repo as one [pi package](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md); every extension under `extensions/` is loaded together.

## Install

```bash
pi install git:github.com/AirboZH/airbozh-pi-plugins
pi install /path/to/airbozh-pi-plugins
```

If you already have a copy of the same extension in `~/.pi/agent/extensions/`, remove or disable that file so it does not load twice.

## Extensions

### herdr-tab-name

Names the current Herdr tab from the first real user prompt of a session. It also optionally sets Pi's session name so `/resume` matches.

- `/herdr-name` — regenerate the tab name from the current prompt
- `/herdr-name <label>` — set an explicit tab name

Optional `~/.pi/agent/herdr-tab-name.json`:

```json
{
  "enabled": true,
  "oncePerSession": true,
  "setSessionName": true
}
```

## Develop

```bash
npm install
npm run typecheck
```

Add a new plugin as `extensions/<name>.ts`. Pi loads all files in that directory.
