import React from 'react';
import ReactDOM from 'react-dom/client';
// Este repo es la DEMO para prospectos: arranca AppDemo. App.jsx (el panel
// completo) se conserva sin tocar para poder traer sus cambios con un merge.
import AppDemo from './AppDemo.jsx';
import './styles.css';
import './rediseno.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppDemo />
  </React.StrictMode>
);
