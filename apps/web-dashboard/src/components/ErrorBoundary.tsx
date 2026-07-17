import React from "react";
import { Button, Result } from "antd";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <Result
          status="error"
          title="页面加载异常"
          subTitle={
            import.meta.env.PROD
              ? "抱歉，页面出现了意外错误。请刷新页面重试。"
              : this.state.error?.message ?? "未知错误"
          }
          extra={[
            <Button type="primary" key="refresh" onClick={() => window.location.reload()}>
              刷新页面
            </Button>,
            <Button key="retry" onClick={this.handleReset}>
              重试
            </Button>,
          ]}
        />
      );
    }

    return this.props.children;
  }
}
