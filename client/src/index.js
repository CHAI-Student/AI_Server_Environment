/* eslint-disable */
import { createRoot } from "react-dom/client";
import './index.css';
import App from './components/App';
import * as serviceWorker from './serviceworker';
import { BrowserRouter } from "react-router-dom";

const container = document.getElementById("root");
const root = createRoot(container);

root.render(
        <BrowserRouter basename="/chai">
        {/* <BrowserRouter> */}
                <App />
        </BrowserRouter>
);
serviceWorker.unregister();