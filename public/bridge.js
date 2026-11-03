// The lobby and all game pages share a nickname, while game sessions stay isolated.
document.addEventListener('DOMContentLoaded', () => {
  const nickname = document.getElementById('nickname');
  if (!nickname) { return; }
  try { nickname.value = localStorage.getItem('lan-player-name') || nickname.value; }
  catch { /* The input remains usable without persistence. */ }
  nickname.maxLength = 12;
  nickname.addEventListener('input', () => {
    try { localStorage.setItem('lan-player-name', nickname.value); }
    catch { /* Persistence is optional. */ }
  });
});
