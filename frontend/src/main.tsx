import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource/golos-text/latin-400.css';
import '@fontsource/golos-text/cyrillic-400.css';
import '@fontsource/golos-text/latin-500.css';
import '@fontsource/golos-text/cyrillic-500.css';
import '@fontsource/golos-text/latin-600.css';
import '@fontsource/golos-text/cyrillic-600.css';
import '@fontsource/golos-text/latin-700.css';
import '@fontsource/golos-text/cyrillic-700.css';
import './styles.css';
import './dashboard-theme.css';
class ErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="fatal">
        <h1>Не удалось отобразить экран</h1>
        <p>
          Данные сервера могли не совпасть с контрактом интерфейса. Обновите страницу или сообщите
          команде.
        </p>
        <button className="primary" onClick={() => location.reload()}>
          Обновить страницу
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
