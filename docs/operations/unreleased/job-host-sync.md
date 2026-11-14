### Workers: larger job trees use repos

Workers jobs on our own hosts use a repo checkout for large trees. Inline files
remain available for small inputs, up to 8 MiB total. The Worker removed the
legacy per-file snapshot download endpoint with the Volume Durable Object.
