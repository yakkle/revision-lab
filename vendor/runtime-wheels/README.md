# Browser runtime wheels

These wheels are committed so the browser runtime never installs packages from a CDN or package index.

| Package | Version | Source | License |
|---|---:|---|---|
| Alembic | 1.19.1 | PyPI wheel | MIT |
| Mako | 1.3.10 | PyPI wheel | MIT |
| MarkupSafe | 3.0.3 | Pyodide 314.0.6 distribution | BSD-3-Clause |
| micropip | 0.11.1 | Pyodide 314.0.6 distribution | MPL-2.0 |
| SQLAlchemy | 2.0.48 | Pyodide 314.0.6 distribution | MIT |
| typing_extensions | 4.15.0 | Pyodide 314.0.6 distribution | PSF-2.0 |

`scripts/prepare-runtime.mjs` verifies the committed wheel checksums before copying them into the production asset tree. Package license files remain included in each wheel's `.dist-info` directory.
