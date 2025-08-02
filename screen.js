const container = document.getElementById('container');

// Factory to make an observer for a single section
const createSectionObserver = (onEnter, onLeave) =>
    new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (entry.intersectionRatio === 1) onEnter();
            else if (entry.intersectionRatio === 0) onLeave();
        }
    }, { root: container, threshold: [0.1, 1] });

// Section 1
const sec1 = document.getElementById('gameScreen');
createSectionObserver(
    () => { console.log('Enter gameScreen'); /* start 1 */ },
    () => { console.log('Leave gameScreen'); /* stop 1 */ }
).observe(sec1);
// === custom swipe handling ===
const THRESHOLD = 30;
let startX = 0;
let startY = 0;
let startTarget = null;
let pointerDown = false;

const onSwipeLeft = () => {
    console.log('Swiped LEFT!');
    Game.run(Game.current + 1);
};
const onSwipeRight = () => {
    console.log('Swiped RIGHT!');
    Game.run(Game.current - 1);
};

const scrollToIndex = idx => {
    const top = idx * container.clientHeight;
    container.scrollTo({ top, behavior: 'smooth' });
};
const currentIndex = () => Math.round(container.scrollTop / container.clientHeight);
const scrollNext = () => {
    const max = container.childElementCount - 1;
    const i = currentIndex();
    if (i < max) scrollToIndex(i + 1);
};
const scrollPrev = () => {
    const i = currentIndex();
    if (i > 0) scrollToIndex(i - 1);
};

const handleSwipe = (dx, dy, target) => {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absY > absX && absY > THRESHOLD) {
        dy < 0 ? scrollNext() : scrollPrev();
    } else if (absX > absY && absX > THRESHOLD) {
        if (target.closest('#gameScreen')) {
            dx < 0 ? onSwipeLeft() : onSwipeRight();
        }
    }
};

// Pointer events unify mouse and touch interactions
container.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    pointerDown = true;
    startX = e.clientX;
    startY = e.clientY;
    startTarget = e.target;
    if (e.pointerType === 'mouse') e.preventDefault();
});

container.addEventListener('pointerup', e => {
    if (!pointerDown || !e.isPrimary) return;
    pointerDown = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    handleSwipe(dx, dy, startTarget);
});

// Cancel a drag if the pointer leaves or is cancelled
const cancelPointer = () => { pointerDown = false; };
container.addEventListener('pointerleave', cancelPointer);
container.addEventListener('pointercancel', cancelPointer);


(function() {
  // Scan for number inputs once DOM is ready
  function init() {
    document.querySelectorAll('input[type=number]:not([data-spinner])').forEach(input => {
      input.setAttribute('data-spinner', '');

      // wrap + buttons
      const wrap = document.createElement('span');
      wrap.className = 'num-spinner';
      input.before(wrap);
      wrap.append(input,
        Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'down',
          textContent: '−',
          onclick() {
            input.stepDown();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            update();
          }
        }),
        Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'up',
          textContent: '+',
          onclick() {
            input.stepUp();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            update();
          }
        })
      );

      // disable at bounds
      function update() {
        const val = parseFloat(input.value);
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);
        wrap.querySelector('.down').disabled = !isNaN(min) && val <= min;
        wrap.querySelector('.up')  .disabled = !isNaN(max) && val >= max;
      }
      input.addEventListener('input', update);
      update();
    });
  }

  // basic styling
  const style = document.createElement('style');
  style.textContent = `
    .num-spinner {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid #ccc;
      border-radius: 4px;
      overflow: hidden;
    }
    .num-spinner input {
      width: 4em;
      border: none;
      padding: 0 .5em;
      text-align: center;
      outline: none;
    }
    .num-spinner button {
      border: none;
      background: #eee;
      padding: 0 .75em;
      cursor: pointer;
      font-size: 1em;
      line-height: 1;
    }
    .num-spinner button:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `;
  document.head.append(style);

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
