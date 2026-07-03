function() {
  return new Promise(function(resolve) {
    var totalHeight = 0;
    var timer = setInterval(function() {
      window.scrollBy(0, 300);
      totalHeight += 300;
      if (totalHeight >= document.body.scrollHeight || totalHeight > 5000) {
        clearInterval(timer);
        resolve();
      }
    }, 300);
  });
}
