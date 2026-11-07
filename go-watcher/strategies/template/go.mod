module strategy

// Pinned to the SAME language version the watcher and CI use. A strategy is
// compiled to wasip1 by the pipeline and its sha256 is what the registry
// records, so a toolchain gap between a laptop and CI is how a "reproducible"
// artifact silently stops being reproducible.
go 1.25.0
