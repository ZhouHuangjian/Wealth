import "@ant-design/v5-patch-for-react-19";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import "./styles.css";
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
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#437665",
          colorInfo: "#437665",
          colorSuccess: "#437665",
          colorWarning: "#A87520",
          colorError: "#AD514A",
          colorText: "#2E2925",
          colorBgContainer: "#fffdf7",
          colorBorder: "#ddd5c6",
          borderRadius: 8,
          fontSize: 14,
          fontFamily: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
          controlHeight: 38,
        },
        components: {
          Table: { headerBg: "#f5f2e9", rowHoverBg: "#faf8f0" },
          Tabs: { inkBarColor: "#437665" },
          Button: { primaryShadow: "0 2px 0 rgba(48,76,56,.1)" },
        },
      }}
    >
      <AntApp>
        <BrowserRouter>
          <PageBoundary>
            <App />
          </PageBoundary>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
