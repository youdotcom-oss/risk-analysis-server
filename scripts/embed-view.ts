/**
 * Bundle the MCP Apps view (mcp-app.html + src/mcp-app-view.ts) into a
 * single self-contained HTML file with Bun's standalone-HTML bundler.
 * Output lands in bin/mcp-app.html; the server reads it at runtime and
 * falls back to the stored report HTML when the bundle is absent.
 */
const bundled = await Bun.build({
  entrypoints: ['./mcp-app.html'],
  outdir: './bin',
  target: 'browser',
  compile: true,
  minify: true,
})

if (!bundled.success) {
  console.error('view bundle failed:', bundled.logs)
  process.exit(1)
}
console.log('bundled view shell -> bin/mcp-app.html')
