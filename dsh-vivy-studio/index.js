import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const name = "vivy-studio-skin"
export const inject = ["webServer"]

/* Single source of truth for the product name. The document title, the client
   rename script and the sidebar wordmark (via the __VIVY_PRODUCT__ token in
   theme.css) all derive from this constant. */
const PRODUCT = "Nierland"

/* Fluorite gem tab icon, matching the sidebar mark. Inline SVG because a
   browser icon cannot read the sheet's CSS variables; the two fills mirror the
   fluorite pair in theme.css. */
const GEM =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'>" +
  "<path fill='#2aa8a4' d='M10 1.6 18.4 10 10 18.4 1.6 10Z'/>" +
  "<path fill='#fbf7f0' d='M10 6.3 13.7 10 10 13.7 6.3 10Z'/>" +
  "</svg>"

const here = dirname(fileURLToPath(import.meta.url))
const themeCss = readFileSync(join(here, "theme.css"), "utf8").replace(
  /__VIVY_PRODUCT__/g,
  PRODUCT,
)
const brandJs = readFileSync(join(here, "brand.js"), "utf8")

const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(GEM)}" />`

function withFavicon(html) {
  const official = /<link[^>]*\brel="icon"[^>]*>/i
  if (official.test(html)) return html.replace(official, FAVICON)
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head === null) return html + FAVICON
  const at = head.index + head[0].length
  return html.slice(0, at) + FAVICON + html.slice(at)
}

function injectSkin(html) {
  const titled = withFavicon(
    html.replace(/<title>[^<]*<\/title>/i, `<title>${PRODUCT}</title>`),
  )
  const snippet =
    `<style data-plugin="dsh-vivy-studio">${themeCss}</style>` +
    `<script data-plugin="dsh-vivy-studio">window.__VIVY_PRODUCT__=${JSON.stringify(PRODUCT)};${brandJs}</script>`
  const body = /<body(?:\s[^>]*)?>/i.exec(titled)
  if (body === null) return titled + snippet
  const at = body.index + body[0].length
  return titled.slice(0, at) + snippet + titled.slice(at)
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => injectSkin(html)),
    "vivy-studio: fluorite theme and product identity",
  )
}
