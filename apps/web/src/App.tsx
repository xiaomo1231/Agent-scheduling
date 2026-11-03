import type { ReactNode } from 'react';
import { useConn, useRoute, useStore } from './hooks';
import { token } from './api';
import { Home, ProjectPage } from './project';
import { ModelsPage } from './models';
import { LogPage, SecurityPage } from './security';
import { SkillsPage } from './skills';
import { Toasts } from './toast';
import { UsagePage } from './usage';
import { ChannelsPage } from './channels';
import { FlowEditorPage } from './floweditor';

export function App() {
  const st = useStore();
  const conn = useConn();
  const [route, go] = useRoute();
  if (!token || conn === 'unauthorized') {
    return (
      <div className="gate card">
        <h1>打不开中枢</h1>
        <p className="sub">这个页面需要带口令的地址。从桌面版直接打开，或者用命令行启动时打印出来的那个地址（末尾带 #token=…）。</p>
      </div>
    );
  }
  const [page, a, b] = route;
  const pending = Object.values(st.approvals).filter((x) => x.state === 'pending').length;
  const projects = Object.values(st.projects).filter((p) => !p.archived);
  const link = (href: string, on: boolean, text: string, extra?: ReactNode) => (
    <a href={'#/' + href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>{text}{extra}</a>
  );
  let view;
  switch (page) {
    case 'p': view = <ProjectPage st={st} projectId={a ?? ''} thread={b ?? null} go={go} />; break;
    case 'flow': {
      const [id, q] = (a ?? 'new').split('?');
      view = <FlowEditorPage st={st} flowId={id || 'new'} projectId={new URLSearchParams(q ?? '').get('p')} />;
      break;
    }
    case 'models': view = <ModelsPage st={st} />; break;
    case 'security': view = <SecurityPage st={st} />; break;
    case 'skills': view = <SkillsPage st={st} />; break;
    case 'log': view = <LogPage st={st} />; break;
    case 'usage': view = <UsagePage st={st} />; break;
    case 'channels': view = <ChannelsPage st={st} />; break;
    default: view = <Home st={st} go={go} />;
  }
  return (
    <div className="app">
      <div className="top">
        <span className="brand"><i />中枢</span>
        <span className={'conn ' + conn}>{conn === 'online' ? '已连接' : conn === 'connecting' ? '连接中…' : '连接断了，正在重连'}</span>
        <span className="spacer" />
        {st.emergencyStop && <a className="pill wait" href="#/security">已紧急停止</a>}
        {pending > 0 && <a className="pill wait" href="#/security">{pending} 件事等你批准</a>}
      </div>
      <nav aria-label="主导航">
        {link('', !page, '首页')}
        <div className="sec">项目</div>
        {projects.map((p) => {
          const active = Object.values(st.threads).filter((t) => t.projectId === p.id && t.kind !== 'coord' && !t.resolved).length;
          return (
            <a key={p.id} href={`#/p/${p.id}`} className={page === 'p' && a === p.id ? 'on' : ''}>
              <span className="dot" style={{ background: p.color }} />{p.name}{active > 0 && <span className="n">{active}</span>}
            </a>
          );
        })}
        <div className="sec">设置</div>
        {link('models', page === 'models', '模型')}
        {link('usage', page === 'usage', '用量', Object.keys(st.quota).length ? <span className="n alert">等</span> : null)}
        {link('channels', page === 'channels', '消息渠道')}
        {link('security', page === 'security', '权限与安全', pending ? <span className="n alert">{pending}</span> : null)}
        {link('skills', page === 'skills', 'Skills')}
        {link('log', page === 'log', '留痕')}
      </nav>
      <main>{view}</main>
      <Toasts />
    </div>
  );
}
