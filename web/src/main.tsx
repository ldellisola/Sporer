import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./api/queries";
import { App } from "./app/App";
import { registerServiceWorker } from "./app/registerServiceWorker";
import "./styles/tokens.css";
import "./styles/global.css";

const container = document.getElementById("root");
if (container === null) throw new Error("index.html has no #root element.");

const queryClient = createQueryClient();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

// After the first render: the app is on its way whatever the registration does. It waits for the page's load event by itself.
registerServiceWorker({ production: import.meta.env.PROD, navigator, window });
