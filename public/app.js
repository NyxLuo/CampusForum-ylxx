document.addEventListener('click', async (e) => {
  const likeBtn = e.target.closest('.btn-like');
  if (likeBtn) {
    const type = likeBtn.dataset.type;
    const id = likeBtn.dataset.id;
    const urlMap = { post: `/p/${id}/like`, reply: `/r/${id}/like`, wall: `/wall/${id}/like` };
    try {
      const res = await fetch(urlMap[type], { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        likeBtn.querySelector('.like-count').textContent = data.count;
        let liked = likeBtn.querySelector('.liked');
        if (liked) liked.remove();
        else {
          const s = document.createElement('span');
          s.className = 'liked';
          s.textContent = '已赞';
          likeBtn.appendChild(s);
        }
      } else if (data.message) {
        alert(data.message);
      }
    } catch (err) {}
  }

  const reportBtn = e.target.closest('.report-btn');
  if (reportBtn) {
    document.getElementById('reportType').value = reportBtn.dataset.type;
    document.getElementById('reportId').value = reportBtn.dataset.id;
    document.getElementById('reportModal').style.display = 'flex';
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'reportForm') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const res = await fetch('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fd)
    });
    const data = await res.json();
    if (data.ok) {
      alert('举报已提交，感谢你的反馈');
      closeReport();
    } else {
      alert(data.message || '举报失败');
    }
  }
});

function closeReport() {
  const m = document.getElementById('reportModal');
  if (m) m.style.display = 'none';
}