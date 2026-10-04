// flamebeat entry point (skeleton; renderer lands in phase 3)
const msg = document.getElementById('msg');
if (!navigator.gpu) {
  msg.hidden = false;
  msg.textContent = 'WebGPU is not available in this browser.';
}
