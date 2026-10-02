import "@ant-design/v5-patch-for-react-19";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import { ThemeProvider } from "./ThemeProvider";
class PageBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="blank-state" role="alert">
          <h1>页面暂时无法打开</h1>
          <p>网页可能刚刚更新，或当前连接中断。已保存的账目仍在账簿中。</p>
          <button onClick={() => window.location.reload()}>重新载入页面</button>
        </main>
      );
    return this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <PageBoundary>
          <App />
        </PageBoundary>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
