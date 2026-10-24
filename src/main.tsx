import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Application } from './app/Application';
import './styles/tokens.css';
import './styles/global.css';

const rootElement = document.querySelector<HTMLElement>('#root');

if (rootElement === null) {
  throw new Error('Không tìm thấy phần tử gốc để khởi tạo ứng dụng.');
}

createRoot(rootElement).render(
  <StrictMode>
    <Application />
  </StrictMode>,
);
