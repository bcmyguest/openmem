# Docs assets

Regenerate the setup demo GIF after wizard output changes:

```sh
uv run --with pillow python scripts/render-setup-gif.py
cp docs/assets/setup-demo.gif site/public/setup-demo.gif
```

The capture uses stubbed `docker`/`curl` and `npx @bcmyguest/openmem setup --dry-run` (via `wizard/bin/setup.mjs`).
