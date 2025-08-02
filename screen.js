const container = document.getElementById('container');
const options = { root: container, threshold: [0.1, 1] };

// Factory to make an observer for a single section
function createSectionObserver(onEnter, onLeave) {
    return new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.intersectionRatio === 1) onEnter();
            else if (entry.intersectionRatio === 0) onLeave();
        });
    }, options);
}

// Section 1
const sec1 = document.getElementById('gameScreen');
const obs1 = createSectionObserver(
    () => { console.log('Enter gameScreen'); /* start 1 */ },
    () => { console.log('Leave gameScreen'); /* stop 1 */ }
);
obs1.observe(sec1);

// Section 2
/*const sec2 = document.getElementById('configScreen');
Game.setTeams(App.Config.get().teamA, App.Config.get().teamB);
const obs2 = createSectionObserver(
    () => { console.log('Enter configScreen'); App.Controller.setPreview(true); },
    () => { console.log('Leave configScreen'); App.Controller.setPreview(false); }
);
obs2.observe(sec2);
*/
// === custom swipe handling ===
let startX = 0, startY = 0, startTarget = null, isMouseDown = false;

function onSwipeLeft() {
    console.log('Swiped LEFT!');
    Game.run(Game.current + 1);
}
function onSwipeRight() {
    console.log('Swiped RIGHT!');
    Game.run(Game.current - 1);
}

function scrollToIndex(idx) {
    const top = idx * container.clientHeight;
    container.scrollTo({ top, behavior: 'smooth' });
}
function currentIndex() {
    return Math.round(container.scrollTop / container.clientHeight);
}
function scrollNext() {
    const max = container.children.length - 1;
    const i = currentIndex();
    if (i < max) scrollToIndex(i + 1);
}
function scrollPrev() {
    const i = currentIndex();
    if (i > 0) scrollToIndex(i - 1);
}

function handleSwipe(dx, dy, target) {
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 30) {
        dy < 0 ? scrollNext() : scrollPrev();
    } else if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 30) {
        if (target.closest('#gameScreen')) {
            dx < 0 ? onSwipeLeft() : onSwipeRight();
        }
    }
}

// TOUCH
container.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startTarget = e.target;
    }
}, { passive: true });

container.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    handleSwipe(dx, dy, startTarget);
});

// MOUSE
container.addEventListener('mousedown', e => {
    isMouseDown = true;
    startX = e.clientX;
    startY = e.clientY;
    startTarget = e.target;
    // prevent text selection while dragging
    e.preventDefault();
});

container.addEventListener('mouseup', e => {
    if (!isMouseDown) return;
    isMouseDown = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    handleSwipe(dx, dy, startTarget);
});

// Optional: cancel a drag if the cursor leaves the container
container.addEventListener('mouseleave', () => {
    isMouseDown = false;
});
