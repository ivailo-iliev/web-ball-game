/* Utility functions shared across game scripts */
const domCache = {};
window.$ = sel => domCache[sel] || (domCache[sel] = document.querySelector(sel));

window.u = Object.freeze({
  rand      : n      => Math.random() * n,
  pick      : arr    => arr[Math.floor(Math.random() * arr.length)],
  between   : (a, b) => a + Math.random() * (b - a),
  clamp     : (n,l,h)=> n < l ? l : n > h ? h : n,
  toEvenInt : n      => Math.round(n) & ~1
});
