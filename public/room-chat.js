(() => {
  const game = document.body.dataset.platformGame;
  const form = document.getElementById('chat-form');
  if (!game || !form) { return; }
  const input = document.getElementById('chat-input');
  const list = document.getElementById('chat-messages');
  const status = document.createElement('p');
  status.className = 'chat-status';
  status.setAttribute('role', 'status');
  form.after(status);

  function create({ form, input, list, send }) {
    let messages = [];
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) { return; }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      status.textContent = '';
      try {
        await send(text);
        input.value = '';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
        input.focus();
      }
    });
    return (nextMessages = []) => {
      if (JSON.stringify(messages) === JSON.stringify(nextMessages)) { return; }
      messages = nextMessages;
      const items = messages.map((message) => {
        const item = document.createElement('li');
        const meta = document.createElement('div');
        const name = document.createElement('strong');
        const time = document.createElement('time');
        const content = document.createElement('p');
        const date = new Date(message.time);
        name.textContent = message.name;
        time.textContent = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        time.dateTime = date.toISOString();
        content.textContent = message.text;
        meta.append(name, time);
        item.append(meta, content);
        return item;
      });
      list.replaceChildren(...items);
      list.scrollTop = list.scrollHeight;
    };
  }
  const render = create({ form, input, list, send: async (text) => {
    const response = await fetch(`/games/${game}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(localStorage.getItem(`lan-${game}-session`) ? { Authorization: `Bearer ${localStorage.getItem(`lan-${game}-session`)}` } : {}) },
      body: JSON.stringify({ text })
    });
    const result = await response.json();
    if (!response.ok) { throw new Error(result.error || '发送失败，请重试。'); }
    window.updateRoomChat(result.state);
  } });
  window.updateRoomChat = (state) => {
    const section = document.querySelector('.room-chat');
    section.hidden = !state || state.practice === true;
    if (state && !state.practice) { render(state.chat); }
  };
})();
