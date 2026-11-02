import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './style.css';
import './style-reference.css';
import './style-doubao.css';
import './style-refinements.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
