import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('failed to fetch dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('loading chunk') ||
    msg.includes('loading css chunk')
  );
}

export default class ChunkErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    if (isChunkLoadError(error)) {
      return { error };
    }
    throw error; // 非 chunk 错误继续向上抛
  }

  handleRefresh = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 40,
          color: 'var(--text-main)',
          fontFamily: 'var(--font-mono)',
          gap: 16,
        }}>
          <div style={{ fontSize: 14, textAlign: 'center' }}>
            检测到新版本已部署，请刷新页面以加载最新内容。
          </div>
          <button
            onClick={this.handleRefresh}
            style={{
              padding: '8px 20px',
              fontSize: 13,
              cursor: 'pointer',
              borderRadius: 4,
              border: '1px solid var(--wf-border)',
              background: 'var(--btn-bg)',
              color: 'var(--text-main)',
            }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
