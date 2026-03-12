import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import SyncofyPlatform from '../syncofy_platform.jsx';

const PASS_HASH = '162c6a8d'; // pre-computed hash of the password

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function Gate() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('syncofy_auth') === '1');
  const [pw, setPw] = useState('');
  const [error, setError] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    if (hashCode(pw) === PASS_HASH) {
      sessionStorage.setItem('syncofy_auth', '1');
      setAuthed(true);
    } else {
      setError(true);
      setPw('');
    }
  };

  if (authed) return <SyncofyPlatform />;

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0B0F1A', fontFamily: "'DM Sans', sans-serif",
    }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap');`}</style>
      <form onSubmit={submit} style={{
        background: '#141825', border: '1px solid #1E2333', borderRadius: 12,
        padding: 40, width: 340, textAlign: 'center',
      }}>
        <div style={{ fontSize: 22, fontWeight: 600, color: '#F1F5F9', marginBottom: 8 }}>
          Syncofy
        </div>
        <div style={{ fontSize: 14, color: '#94A3B8', marginBottom: 24 }}>
          Enter password to continue
        </div>
        <input
          type="password"
          value={pw}
          onChange={e => { setPw(e.target.value); setError(false); }}
          placeholder="Password"
          autoFocus
          style={{
            width: '100%', padding: '10px 14px', fontSize: 15, borderRadius: 8,
            border: `1px solid ${error ? '#EF4444' : '#1E2333'}`, background: '#0B0F1A',
            color: '#F1F5F9', outline: 'none', boxSizing: 'border-box', marginBottom: 16,
          }}
        />
        {error && <div style={{ color: '#EF4444', fontSize: 13, marginBottom: 12 }}>Incorrect password</div>}
        <button type="submit" style={{
          width: '100%', padding: '10px 0', fontSize: 15, fontWeight: 600,
          borderRadius: 8, border: 'none', cursor: 'pointer',
          background: 'linear-gradient(135deg, #6366F1, #14B8A6)', color: '#fff',
        }}>
          Enter
        </button>
      </form>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Gate />
  </React.StrictMode>
);
