function() {
  function getMeta(name) {
    var el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
    return el ? (el.getAttribute('content') || '') : '';
  }

  var ldJson = null;
  var ldEl = document.querySelector('script[type="application/ld+json"]');
  if (ldEl) ldJson = ldEl.textContent;

  var initialState = null;
  try {
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var text = scripts[i].textContent || '';
      var initMatch = text.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/s);
      var dataMatch = text.match(/window\.__DATA__\s*=\s*({.+?});/s);
      var m = initMatch || dataMatch;
      if (m) {
        try { initialState = JSON.parse(m[1]); } catch(e) {}
        break;
      }
    }
  } catch(e) {}

  var images = [];
  var imgs = document.querySelectorAll('img');
  for (var j = 0; j < imgs.length; j++) {
    var src = imgs[j].src || imgs[j].getAttribute('data-src') || '';
    if (src) images.push(src);
  }

  return {
    title: document.title,
    html: document.documentElement.outerHTML.substring(0, 100000),
    url: window.location.href,
    ogTitle: getMeta('og:title'),
    ogDescription: getMeta('og:description'),
    ogImage: getMeta('og:image'),
    ldJson: ldJson,
    initialState: initialState,
    images: images,
    metaKeywords: getMeta('keywords')
  };
}
