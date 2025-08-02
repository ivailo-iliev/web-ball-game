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
