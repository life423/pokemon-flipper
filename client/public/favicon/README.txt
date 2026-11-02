TRANSPARENT FAVICON PACK

Default: favicon.ico, containing transparent 16x16, 32x32 and 48x48 images.
PNG alternatives: 16, 32, 48, 180, 192 and 512 pixels square.
Master: favicon-master.png (1254x1254 RGBA).
All icon files have real alpha transparency, with no blue square.

INSTALL
Copy favicon.ico and the PNG files into your site's public/static root.
Add the contents of favicon-links.html inside the page's <head>.
Adjust the URLs if your site uses a subdirectory. Do not upload the master
unless you want to keep a downloadable high-resolution source online.

The 180, 192 and 512 PNGs are supplied as larger source assets. Home-screen
launchers may apply their own backgrounds/masks; these are transparent
favicon assets, not a separately designed opaque app-icon or maskable set.

Browsers cache favicons aggressively. If an old icon remains, try a hard
refresh or a versioned URL such as /favicon.ico?v=2.

SOURCE AND PROCESS
Based on your uploaded red, white and black circular artwork. The background
was removed with the image editing tool and the symbol enlarged, then the
transparent master was mechanically downsampled and encoded as PNG and ICO.
No SVG is included: this is raster artwork, not a traced vector file.
