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
const sec2 = document.getElementById('configScreen');
Game.setTeams(App.Config.get().teamA, App.Config.get().teamB);
const obs2 = createSectionObserver(
    () => { console.log('Enter configScreen'); App.Controller.setPreview(true); },
    () => { console.log('Leave configScreen'); App.Controller.setPreview(false); }
);
obs2.observe(sec2);

// === horizontal swipe on #gameScreen only ===
const game = document.getElementById('gameScreen');
let startX = 0, startY = 0;

function onSwipeLeft() {
    console.log('Swiped LEFT!');
    // build ordered list from our MODES constant
    const modeList = Object.values(Game.MODES); 
    const idx      = modeList.indexOf(Game.cfg.mode);
    // next, wrapping around
    const nextIdx  = (idx + 1) % modeList.length;
    Game.setMode(modeList[nextIdx]);
}
function onSwipeRight() {
    console.log('Swiped RIGHT!');
    // build ordered list from our MODES constant
    const modeList = Object.values(Game.MODES);
    const idx      = modeList.indexOf(Game.cfg.mode);
    // previous, wrapping around
    const prevIdx  = (idx - 1 + modeList.length) % modeList.length;
    Game.setMode(modeList[prevIdx]);
}

// TOUCH
game.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }
}, { passive: true });

game.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 30) {
        dx < 0 ? onSwipeLeft() : onSwipeRight();
    }
});

// MOUSE
game.addEventListener('mousedown', e => {
    isMouseDown = true;
    startX = e.clientX;
    startY = e.clientY;
    // prevent text selection while dragging
    e.preventDefault();
});

game.addEventListener('mouseup', e => {
    if (!isMouseDown) return;
    isMouseDown = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 30) {
        dx < 0 ? onSwipeLeft() : onSwipeRight();
    }
});

// Optional: cancel a drag if the cursor leaves the element
game.addEventListener('mouseleave', () => {
    isMouseDown = false;
});