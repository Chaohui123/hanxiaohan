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

  // ---- Supplier Info Extraction ----
  var supplier = { name: '', pickupRate: 0, responseRate: 0, qualityScore: 0, ratings: {} };

  // 1. Try __INITIAL_STATE__ for structured supplier data
  if (initialState) {
    try {
      var store =
        (initialState.sellerInfo && initialState.sellerInfo.sellerName) ? initialState.sellerInfo :
        (initialState.supplierInfo) ? initialState.supplierInfo :
        (initialState.shopInfo) ? initialState.shopInfo :
        (initialState.storeInfo) ? initialState.storeInfo :
        (initialState.data && initialState.data.sellerInfo) ? initialState.data.sellerInfo :
        (initialState.globalData && initialState.globalData.supplier) ? initialState.globalData.supplier :
        (initialState.supplier) ? initialState.supplier : null;

      if (store) {
        supplier.name = store.sellerName || store.supplierName || store.companyName || store.shopName || '';
        supplier.pickupRate = parseFloat(store.deliveryRate || store.shipRate || store.pickupRate24h || store.shipmentRate || 0) / 100 || 0;
        supplier.responseRate = parseFloat(store.responseRate || store.replyRate || 0) / 100 || 0;
        supplier.qualityScore = parseFloat(store.qualityScore || store.productScore || 0) || 0;
      }
    } catch(e) {}
  }

  // 2. Fallback: DOM extraction for supplier name
  if (!supplier.name) {
    var nameSelectors = [
      '.supplier-name', '.shop-name', '.company-name', '.seller-name',
      '[data-mod-config*="seller"] .seller-name',
      '.mod-seller-info .name', '.offer-seller-name',
      '.store-name-text', '.supplier-info .company',
      'a[href*="winport.1688.com"]', 'a[href*="shop.1688.com"]',
    ];
    for (var k = 0; k < nameSelectors.length; k++) {
      var el = document.querySelector(nameSelectors[k]);
      if (el) { supplier.name = (el.textContent || '').trim(); break; }
    }
  }

  // 3. Supplier ratings from 1688 badge elements (shows scores like 4.8/5.0)
  var ratingEls = document.querySelectorAll('.supplier-score, .shop-score, .seller-rating, [class*="score"]');
  for (var r = 0; r < ratingEls.length; r++) {
    var text = (ratingEls[r].textContent || '').trim();
    // Pattern: "发货速度 4.8" or "揽收率 95%" or "24h发货率 98%"
    var shipMatch = text.match(/(?:发货|揽收|出货|发货率|pickup|ship).*?(\d+\.?\d*)\s*%?/i);
    if (shipMatch && !supplier.pickupRate) {
      supplier.pickupRate = parseFloat(shipMatch[1]) / 100;
      if (supplier.pickupRate > 1) supplier.pickupRate = supplier.pickupRate / 100; // normalize if > 1
    }
    var respMatch = text.match(/(?:响应|回复|reply).*?(\d+\.?\d*)\s*%?/i);
    if (respMatch && !supplier.responseRate) {
      supplier.responseRate = parseFloat(respMatch[1]) / 100;
      if (supplier.responseRate > 1) supplier.responseRate = supplier.responseRate / 100;
    }
  }

  // 4. Extract supplier ratings from the "supplier badges" section
  var badgeContainer = document.querySelector('.supplier-badges, .shop-badges, .seller-badges, .mod-supplier-quality');
  if (badgeContainer) {
    var badgeTexts = (badgeContainer.textContent || '').match(/(\d+\.?\d*)%/g);
    if (badgeTexts && !supplier.pickupRate) {
      // Typically the last percentage shown is delivery/shipping related
      for (var b = 0; b < badgeTexts.length; b++) {
        var pct = parseFloat(badgeTexts[b]) / 100;
        if (pct > 0 && pct <= 1) {
          supplier.pickupRate = pct;
        }
      }
    }
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
    metaKeywords: getMeta('keywords'),
    supplier: supplier
  };
}
