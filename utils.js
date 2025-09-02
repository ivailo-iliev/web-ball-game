/* Utility functions shared across game scripts */
const domCache = {};
window.$ = sel => domCache[sel] || (domCache[sel] = document.querySelector(sel));

// Round a number to the nearest even integer
window.toEvenInt = n => Math.round(n) & ~1;

window.u = Object.freeze({
  rand   : n      => Math.random() * n,
  pick   : arr    => arr[Math.floor(Math.random() * arr.length)],
  between: (a, b) => a + Math.random() * (b - a),
  clamp  : (n,l,h)=> n < l ? l : n > h ? h : n
});

window.populateTeamSelects = function (selA, selB, emojiMap) {
  for (const [team, emoji] of Object.entries(emojiMap)) {
    const opt = document.createElement('option');
    opt.value = team;
    opt.textContent = emoji;
    selA.appendChild(opt);
    selB.appendChild(opt.cloneNode(true));
  }
};
