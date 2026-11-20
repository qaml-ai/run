### Render SVG cards in camelRun v2

Use `POST /v2/images/render` or `client.images.render(svg, { files })` to render a PNG. Reference named photos with `<image href="photo" …/>` and supply base64 raster data or an existing tenant-owned image ID. Agents with the `images` builtin can call `render_image` to save and inspect the PNG in their repository.
