function() {
  var selectors = [
    '.description-content img',
    '.detail-content img',
    '.mod-detail img',
    '.tab-content-container img'
  ];
  var urls = [];
  var seen = {};
  for (var s = 0; s < selectors.length; s++) {
    try {
      var imgs = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].getAttribute('src') || imgs[i].getAttribute('data-src');
        if (src && src.indexOf('icon') === -1 && src.indexOf('avatar') === -1 && !seen[src]) {
          seen[src] = true;
          urls.push(src.indexOf('//') === 0 ? 'https:' + src : src);
        }
      }
    } catch(e) {}
  }
  return urls;
}
