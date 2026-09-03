package webdesktopmcp

import _ "embed"

// bootstrapScript is the page-side half of the bridge (ES2020, page main
// world). It is injected via InitScript() and served at GET /webdesktopmcp.js.
//
//go:embed js/bootstrap.js
var bootstrapScript string
