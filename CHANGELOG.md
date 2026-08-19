# Changelog

[Compare changes](https://github.com/stacksjs/ts-avif/compare/v0.1.3...v0.1.4)

## ⚡ Performance Improvements

- **build**: cut the waste out of the published output ([ac61ff5](https://github.com/stacksjs/ts-avif/commit/ac61ff5)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.4 ([c87ba93](https://github.com/stacksjs/ts-avif/commit/c87ba93)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/ts-avif/compare/v0.1.2...v0.1.3)

## 🐛 Bug Fixes

- remove consumer postinstall hook ([bfac6ce](https://github.com/stacksjs/ts-avif/commit/bfac6ce)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.3 ([95ab274](https://github.com/stacksjs/ts-avif/commit/95ab274)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: declare bun ^1.3.14 in deps.yaml ([f38cfa6](https://github.com/stacksjs/ts-avif/commit/f38cfa6)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/ts-avif/compare/v0.1.1...v0.1.2)

## 🐛 Bug Fixes

- **test**: speed up ipred vectors test to avoid CI timeout ([7156be6](https://github.com/stacksjs/ts-avif/commit/7156be6)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧹 Chores

- release v0.1.2 ([745501c](https://github.com/stacksjs/ts-avif/commit/745501c)) _(by Chris <chrisbreuer93@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_

[Compare changes](https://github.com/stacksjs/ts-avif/compare/v0.1.0...v0.1.1)

## 🚀 Features

- **av1**: encode full transform coefficients ([d6e0524](https://github.com/stacksjs/ts-avif/commit/d6e0524)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: decode global motion ([105ac87](https://github.com/stacksjs/ts-avif/commit/105ac87)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: decode switchable inter filters ([05ebf8a](https://github.com/stacksjs/ts-avif/commit/05ebf8a)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: reconstruct intrabc transform trees ([9e967f0](https://github.com/stacksjs/ts-avif/commit/9e967f0)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: decode translational inter blocks ([1783302](https://github.com/stacksjs/ts-avif/commit/1783302)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: decode zero-motion inter frames ([02fc07f](https://github.com/stacksjs/ts-avif/commit/02fc07f)) _(by Chris <chrisbreuer93@gmail.com>)_
- decode all-intra AVIF sequences ([9c1c6e8](https://github.com/stacksjs/ts-avif/commit/9c1c6e8)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: synthesize film grain ([5224dad](https://github.com/stacksjs/ts-avif/commit/5224dad)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: decode lossless intra block copy ([a420828](https://github.com/stacksjs/ts-avif/commit/a420828)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: decode palette prediction ([756310f](https://github.com/stacksjs/ts-avif/commit/756310f)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: decode quantization matrices ([da84a93](https://github.com/stacksjs/ts-avif/commit/da84a93)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: support superres and 128x128 blocks ([ba32c8f](https://github.com/stacksjs/ts-avif/commit/ba32c8f)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: decode high-bit-depth intra frames ([f7e08df](https://github.com/stacksjs/ts-avif/commit/f7e08df)) _(by Chris <chrisbreuer93@gmail.com>)_
- **encoder**: replace avifenc with TypeScript intra encoding ([98d56fb](https://github.com/stacksjs/ts-avif/commit/98d56fb)) _(by Chris <chrisbreuer93@gmail.com>)_
- **container**: write associated AVIF image items ([6e6a7e5](https://github.com/stacksjs/ts-avif/commit/6e6a7e5)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: encode intra tiles with DC transforms ([f698d2f](https://github.com/stacksjs/ts-avif/commit/f698d2f)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: write single-tile key frame headers ([28089e5](https://github.com/stacksjs/ts-avif/commit/28089e5)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: write reduced still sequence headers ([e35d8d4](https://github.com/stacksjs/ts-avif/commit/e35d8d4)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: add adaptive arithmetic encoder ([6298426](https://github.com/stacksjs/ts-avif/commit/6298426)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: wire loop restoration into the decode pipeline ([d037824](https://github.com/stacksjs/ts-avif/commit/d037824)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: bit-exact Wiener and self-guided loop restoration filters ([6eabf38](https://github.com/stacksjs/ts-avif/commit/6eabf38)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: record CDEF metadata and apply it in the decode pipeline ([c925c90](https://github.com/stacksjs/ts-avif/commit/c925c90)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: CDEF kernels validated against dav1d reference vectors ([f638d82](https://github.com/stacksjs/ts-avif/commit/f638d82)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: read loop-restoration unit params to keep entropy in sync ([5a05c2a](https://github.com/stacksjs/ts-avif/commit/5a05c2a)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: segment-id map decoding for segmented frames ([50c8100](https://github.com/stacksjs/ts-avif/commit/50c8100)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: deblocking loop filter kernel and driver ([13ead4a](https://github.com/stacksjs/ts-avif/commit/13ead4a)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: pixel reconstruction, YUV->RGBA, and full decode pipeline ([a42fc19](https://github.com/stacksjs/ts-avif/commit/a42fc19)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: inverse transforms validated against dav1d reference ([95ca6b2](https://github.com/stacksjs/ts-avif/commit/95ca6b2)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: intra prediction validated against dav1d reference vectors ([9f3cccf](https://github.com/stacksjs/ts-avif/commit/9f3cccf)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: intra tile decoder - partitions, mode info, and coefficients ([1ce5691](https://github.com/stacksjs/ts-avif/commit/1ce5691)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: default CDF tables generated from the dav1d reference ([2c454b7](https://github.com/stacksjs/ts-avif/commit/2c454b7)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: symbol-adaptive arithmetic decoder validated against dav1d vectors ([7e4959a](https://github.com/stacksjs/ts-avif/commit/7e4959a)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: intra frame header and tile group parsing ([81dd471](https://github.com/stacksjs/ts-avif/commit/81dd471)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: bit reader and spec-complete sequence header parsing ([f7f29cc](https://github.com/stacksjs/ts-avif/commit/f7f29cc)) _(by Chris <chrisbreuer93@gmail.com>)_
- **container**: per-item property resolution, grid and idat support, loud av1 decode failure, real-file tests ([c49c4fb](https://github.com/stacksjs/ts-avif/commit/c49c4fb)) _(by Chris <chrisbreuer93@gmail.com>)_
- **encoder**: add avifenc CLI backend with auto fallback ([3eb495e](https://github.com/stacksjs/ts-avif/commit/3eb495e)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🐛 Bug Fixes

- **av1**: guard advanced inter prediction ([677a410](https://github.com/stacksjs/ts-avif/commit/677a410)) _(by Chris <chrisbreuer93@gmail.com>)_
- **types**: import container box type from public definitions ([68e7097](https://github.com/stacksjs/ts-avif/commit/68e7097)) _(by Chris <chrisbreuer93@gmail.com>)_
- **scripts**: stop double-generating CHANGELOG on release ([e931c39](https://github.com/stacksjs/ts-avif/commit/e931c39)) _(by Glenn Michael Torregosa <gtorregosa@gmail.com>)_

## 📚 Documentation

- document complete codec support ([b65df1b](https://github.com/stacksjs/ts-avif/commit/b65df1b)) _(by Chris <chrisbreuer93@gmail.com>)_
- rewrite project readme ([45c6211](https://github.com/stacksjs/ts-avif/commit/45c6211)) _(by Chris <chrisbreuer93@gmail.com>)_
- document pure TypeScript encoder scope ([b7c8976](https://github.com/stacksjs/ts-avif/commit/b7c8976)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🧪 Tests

- enforce bit-exact photo decoding ([4b9f4d2](https://github.com/stacksjs/ts-avif/commit/4b9f4d2)) _(by Chris <chrisbreuer93@gmail.com>)_
- **av1**: bit-exact YUV gate against the dav1d reference decoder ([1987a05](https://github.com/stacksjs/ts-avif/commit/1987a05)) _(by Chris <chrisbreuer93@gmail.com>)_

## 🤖 Continuous Integration

- drop redundant setup-bun (pantry installs bun via deps.yaml) ([0b4ccd7](https://github.com/stacksjs/ts-avif/commit/0b4ccd7)) _(by glennmichael123 <gtorregosa@gmail.com>)_

## 🧹 Chores

- release v0.1.1 ([c964fc5](https://github.com/stacksjs/ts-avif/commit/c964fc5)) _(by Chris <chrisbreuer93@gmail.com>)_
- add pantry lockfile ([ccee047](https://github.com/stacksjs/ts-avif/commit/ccee047)) _(by Chris <chrisbreuer93@gmail.com>)_
- add project license ([1527b15](https://github.com/stacksjs/ts-avif/commit/1527b15)) _(by Chris <chrisbreuer93@gmail.com>)_
- **deps**: refresh bun.lock to pick up pickier 0.1.37 ([f6df5ce](https://github.com/stacksjs/ts-avif/commit/f6df5ce)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: refresh bun.lock to pick up pickier 0.1.35 ([072c132](https://github.com/stacksjs/ts-avif/commit/072c132)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: refresh bun.lock to pick up pickier 0.1.33 ([d79b0a7](https://github.com/stacksjs/ts-avif/commit/d79b0a7)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: refresh bun.lock to pick up @stacksjs/logsmith 0.2.3 ([c0969af](https://github.com/stacksjs/ts-avif/commit/c0969af)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: refresh bun.lock to pick up buddy-bot 0.9.20 ([54d4677](https://github.com/stacksjs/ts-avif/commit/54d4677)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **deps**: bump better-dx to ^0.2.15 ([00208b9](https://github.com/stacksjs/ts-avif/commit/00208b9)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- **ci**: bump actions/checkout to v6, actions/cache to v5 ([d85a030](https://github.com/stacksjs/ts-avif/commit/d85a030)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock to pick up bun-plugin-dtsx@0.9.18 ([ab784ae](https://github.com/stacksjs/ts-avif/commit/ab784ae)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock and apply pickier --fix ([fb77534](https://github.com/stacksjs/ts-avif/commit/fb77534)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock ([f5b29fd](https://github.com/stacksjs/ts-avif/commit/f5b29fd)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- refresh bun.lock to pick up latest pickier ([bb91b6e](https://github.com/stacksjs/ts-avif/commit/bb91b6e)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- wip ([f3da142](https://github.com/stacksjs/ts-avif/commit/f3da142)) _(by Chris <chrisbreuer93@gmail.com>)_

## ⏪ Reverts

- keep staged-lint kebab + bunx gitlint shorthand ([8a50e5b](https://github.com/stacksjs/ts-avif/commit/8a50e5b)) _(by glennmichael123 <gtorregosa@gmail.com>)_

## Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _Glenn Michael Torregosa <gtorregosa@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_

### 🧹 Chores

- add release and buddy-bot workflows ([086854d](https://github.com/stacksjs/ts-avif/commit/086854d)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- set version to 0.0.1 ([49b3298](https://github.com/stacksjs/ts-avif/commit/49b3298)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- migrate to better-dx, add CI workflow ([b875e78](https://github.com/stacksjs/ts-avif/commit/b875e78)) _(by glennmichael123 <gtorregosa@gmail.com>)_
- add release:patch / release:minor / release:major scripts ([c3712d4](https://github.com/stacksjs/ts-avif/commit/c3712d4)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([3085b96](https://github.com/stacksjs/ts-avif/commit/3085b96)) _(by Chris <chrisbreuer93@gmail.com>)_
- wip ([a24c146](https://github.com/stacksjs/ts-avif/commit/a24c146)) _(by Chris <chrisbreuer93@gmail.com>)_
- initial commit ([1eab044](https://github.com/stacksjs/ts-avif/commit/1eab044)) _(by Chris <chrisbreuer93@gmail.com>)_

### Contributors

- _Chris <chrisbreuer93@gmail.com>_
- _glennmichael123 <gtorregosa@gmail.com>_
