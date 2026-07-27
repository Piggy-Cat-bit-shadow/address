import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';

type View = 'dashboard' | 'access' | 'providers' | 'china' | 'tokens' | 'runs' | 'audit' | 'system';
interface Credential { id: string; provider: string; label: string; mask: string; enabled: boolean; status: string; usedToday: number; dailyLimit: number; qpsLimit: number; weight: number; quotaScopeId: string; lastSuccessAt?: string }
interface Dashboard { addressCount: number; china: Record<string, unknown>; credentials: Credential[]; runs: Array<Record<string, unknown>>; storage: { addressBytes: number; controlBytes: number } }

const labels: Record<View, string> = {
  dashboard: '仪表盘', access: '访问与安全', providers: '地图 Key', china: '中国同步', tokens: 'API Token',
  runs: '任务中心', audit: '审计日志', system: '系统管理'
};
const formatBytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const dateTime = (value: unknown) => value ? new Date(String(value)).toLocaleString('zh-CN', { hour12: false }) : '-';

export default function SyncAdmin() {
  const [authenticated, setAuthenticated] = useState(false);
  const [initialized, setInitialized] = useState(true);
  const [password, setPassword] = useState('');
  const [csrf, setCsrf] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [data, setData] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const request = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(`/admin/api${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers },
      credentials: 'same-origin'
    });
    const body = await response.json() as { data?: T; error?: string; detail?: string };
    if (!response.ok) throw new Error(body.detail || body.error || `HTTP ${response.status}`);
    return body.data as T;
  }, [csrf]);

  const load = useCallback(async (selected: View) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const paths: Record<View, string> = {
        dashboard: '/dashboard', access: '/settings/access', providers: '/providers', china: '/china/status',
        tokens: '/tokens', runs: '/runs', audit: '/audit', system: '/system'
      };
      setData(await request(paths[selected]));
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }, [request]);

  useEffect(() => {
    setCsrf(window.sessionStorage.getItem('address-admin-csrf') || '');
    void fetch('/admin/api/status').then((response) => response.json()).then((body) => setInitialized(Boolean(body.data?.initialized)));
    void fetch('/admin/api/session', { credentials: 'same-origin' }).then((response) => {
      setAuthenticated(response.ok);
      if (response.ok) void load('dashboard');
    });
  }, []);

  const login = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await fetch('/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), credentials: 'same-origin' });
      const body = await result.json();
      if (!result.ok) throw new Error(body.error || '登录失败');
      sessionStorage.setItem('address-admin-csrf', body.data.csrfToken);
      setCsrf(body.data.csrfToken); setAuthenticated(true); setPassword('');
      setTimeout(() => void load('dashboard'), 0);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };

  const mutate = async (path: string, method: string, body?: unknown, success = '操作已完成') => {
    setBusy(true); setError(''); setNotice('');
    try { await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); setNotice(success); await load(view); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };

  if (!authenticated) return <main className="admin-login">
    <form onSubmit={login}>
      <p>ADDRESS 管理系统</p><h1>管理员登录</h1>
      {!initialized && <div className="admin-warning">请先在服务器设置 ADMIN_BOOTSTRAP_PASSWORD 并重启服务。</div>}
      <label><span>管理员密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button disabled={busy || !password}>{busy ? '登录中…' : '登录'}</button>
      {error && <div className="admin-error" role="alert">{error}</div>}
      <a href="/zh-CN/">返回生成器</a>
    </form>
  </main>;

  const selectView = (selected: View) => { setView(selected); void load(selected); };
  const logout = async () => { await request('/logout', { method: 'POST' }); sessionStorage.removeItem('address-admin-csrf'); location.reload(); };

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <div className="admin-brand"><b>ADDRESS</b><span>管理系统</span></div>
      <nav>{(Object.keys(labels) as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => selectView(item)}>{labels[item]}</button>)}</nav>
      <div className="admin-sidebar-actions"><a href="/zh-CN/">返回生成器</a><button onClick={() => void logout()}>退出登录</button></div>
    </aside>
    <main className="admin-content">
      <header><div><p>数据与系统管理</p><h1>{labels[view]}</h1></div><button onClick={() => void load(view)} disabled={busy}>刷新</button></header>
      {error && <div className="admin-error" role="alert">{error}</div>}
      {notice && <div className="admin-notice">{notice}</div>}
      {busy && !data ? <p className="admin-empty">正在加载…</p> : <AdminView view={view} data={data} busy={busy} mutate={mutate} request={request} setNotice={setNotice} />}
    </main>
  </div>;
}

function AdminView({ view, data, busy, mutate, request, setNotice }: {
  view: View; data: unknown; busy: boolean;
  mutate: (path: string, method: string, body?: unknown, success?: string) => Promise<void>;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  setNotice: (value: string) => void;
}) {
  if (view === 'dashboard') {
    const value = data as Dashboard | undefined;
    const china = value?.china || {};
    return <><section className="metric-grid">
      <Metric label="地址总数" value={Number(value?.addressCount || 0).toLocaleString()} />
      <Metric label="中国真实小区" value={Number(china.total || 0).toLocaleString()} />
      <Metric label="已覆盖城市" value={Number(china.cities || 0).toLocaleString()} />
      <Metric label="跨平台验证" value={Number(china.cross_verified || 0).toLocaleString()} />
      <Metric label="地址数据库" value={formatBytes(value?.storage.addressBytes || 0)} />
      <Metric label="控制数据库" value={formatBytes(value?.storage.controlBytes || 0)} />
    </section><Panel title="地图 Key 健康状态"><CredentialTable values={value?.credentials || []} /></Panel></>;
  }
  if (view === 'access') {
    const value = data as { frontendPasswordEnabled?: boolean; apiAuthEnabled?: boolean } | undefined;
    return <Panel title="访问策略"><form className="admin-form" onSubmit={(event) => {
      event.preventDefault(); const values = new FormData(event.currentTarget);
      void mutate('/settings/access', 'PUT', {
        frontendPasswordEnabled: values.get('frontendPasswordEnabled') === 'on', apiAuthEnabled: values.get('apiAuthEnabled') === 'on',
        frontendPassword: values.get('frontendPassword') || undefined, adminPassword: values.get('adminPassword') || undefined
      });
    }}><label className="check"><input name="frontendPasswordEnabled" type="checkbox" defaultChecked={value?.frontendPasswordEnabled} />启用前端访问密码</label>
      <label className="check"><input name="apiAuthEnabled" type="checkbox" defaultChecked={value?.apiAuthEnabled} />外部 API 强制 Bearer Token</label>
      <label><span>新前端密码</span><input name="frontendPassword" type="password" minLength={10} placeholder="留空则保持不变" /></label>
      <label><span>新管理员密码</span><input name="adminPassword" type="password" minLength={10} placeholder="留空则保持不变" /></label>
      <button disabled={busy}>保存设置</button></form></Panel>;
  }
  if (view === 'providers') {
    const credentials = (data || []) as Credential[];
    return <><Panel title="添加地图 Key"><form className="admin-form provider-form" onSubmit={(event) => {
      event.preventDefault(); const values = new FormData(event.currentTarget);
      void mutate('/providers', 'POST', { provider: values.get('provider'), label: values.get('label'), secret: values.get('secret'),
        qpsLimit: Number(values.get('qpsLimit')), dailyLimit: Number(values.get('dailyLimit')), quotaScopeId: values.get('quotaScopeId') || undefined });
      event.currentTarget.reset();
    }}><label><span>平台</span><select name="provider"><option value="amap">高德</option><option value="baidu">百度</option><option value="tencent">腾讯</option></select></label>
      <label><span>名称</span><input name="label" required /></label><label><span>Key</span><input name="secret" type="password" required /></label>
      <label><span>QPS</span><input name="qpsLimit" type="number" min="1" defaultValue="1" /></label><label><span>每日额度</span><input name="dailyLimit" type="number" min="1" defaultValue="1000" /></label>
      <label><span>共享配额组</span><input name="quotaScopeId" placeholder="可选" /></label><button disabled={busy}>加密保存</button></form></Panel>
      <Panel title="已配置 Key"><CredentialTable values={credentials} actions={(credential) => <><button onClick={() => void mutate(`/providers/${credential.id}`, 'PUT', { enabled: !credential.enabled }, credential.enabled ? 'Key 已停用' : 'Key 已启用')}>{credential.enabled ? '停用' : '启用'}</button><button onClick={() => void mutate(`/providers/${credential.provider}/test`, 'POST', undefined, 'Key 测试成功')}>测试</button><button className="danger" onClick={() => void mutate(`/providers/${credential.id}`, 'DELETE')}>删除</button></>} /></Panel></>;
  }
  if (view === 'china') {
    const value = data as { total?: number; cross_verified?: number; cities?: number; running?: boolean; targets?: Array<Record<string, unknown>>; sources?: Array<Record<string, unknown>> } | undefined;
    return <><section className="metric-grid"><Metric label="真实小区" value={Number(value?.total || 0).toLocaleString()} /><Metric label="覆盖城市" value={String(value?.cities || 0)} /><Metric label="跨平台验证" value={String(value?.cross_verified || 0)} /><Metric label="同步状态" value={value?.running ? '运行中' : '空闲'} /></section>
      <Panel title="启动同步"><form className="admin-form" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); const cities = String(values.get('cities') || '').split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean); void mutate('/china/sync', 'POST', { cities: cities.length ? cities : undefined, providers: values.getAll('providers'), maxPages: Number(values.get('maxPages')) }, '同步任务已提交'); }}>
        <label><span>城市（逗号分隔；留空使用首批 43 城）</span><textarea name="cities" placeholder="北京市, 厦门市, 唐山市, 天津市" /></label>
        <div className="check-row">{['amap','baidu','tencent'].map((provider) => <label className="check" key={provider}><input type="checkbox" name="providers" value={provider} defaultChecked />{provider}</label>)}</div>
        <label><span>每平台最大页数</span><input name="maxPages" type="number" min="1" max="50" defaultValue="20" /></label><button disabled={busy || value?.running}>开始同步</button>
      </form></Panel><Panel title="导入 AreaCity 行政区划"><form className="admin-form" onSubmit={(event) => {
        event.preventDefault(); const values = new FormData(event.currentTarget);
        void mutate('/china/areacity', 'POST', { source: values.get('source'), version: values.get('version') }, 'AreaCity 数据已导入');
      }}><label><span>HTTPS JSON/CSV 或 data 目录内 CSV</span><input name="source" required placeholder="imports/ok_data_level4.csv" /></label>
        <label><span>数据版本</span><input name="version" required placeholder="2025.251231.260403" /></label><button disabled={busy}>导入行政区划</button></form></Panel>
      <Panel title="平台数据量"><JsonTable values={value?.sources || []} /></Panel><Panel title="城市覆盖"><JsonTable values={value?.targets || []} /></Panel></>;
  }
  if (view === 'tokens') {
    const tokens = (data || []) as Array<Record<string, unknown>>;
    return <><Panel title="创建 API Token"><form className="admin-form" onSubmit={async (event) => {
      event.preventDefault(); const values = new FormData(event.currentTarget);
      const created = await request<{ token: string }>('/tokens', { method: 'POST', body: JSON.stringify({ name: values.get('name'), scopes: ['read','generate'], rateLimit: Number(values.get('rateLimit')) }) });
      setNotice(`请立即保存 Token（仅显示一次）：${created.token}`); event.currentTarget.reset();
    }}><label><span>名称</span><input name="name" required /></label><label><span>每分钟请求数</span><input name="rateLimit" type="number" min="1" defaultValue="60" /></label><button disabled={busy}>创建 Token</button></form></Panel>
      <Panel title="API Token"><TokenTable values={tokens} revoke={(id) => void mutate(`/tokens/${id}`, 'DELETE', undefined, 'Token 已撤销')} /></Panel></>;
  }
  if (view === 'runs' || view === 'audit') return <Panel title={labels[view]}><JsonTable values={(data || []) as Array<Record<string, unknown>>} /></Panel>;
  return <Panel title="运行环境"><JsonTable values={[data as Record<string, unknown>]} /></Panel>;
}

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="admin-panel"><h2>{title}</h2>{children}</section>;
const Metric = ({ label, value }: { label: string; value: string }) => <div className="metric"><span>{label}</span><b>{value}</b></div>;
const CredentialTable = ({ values, actions }: { values: Credential[]; actions?: (value: Credential) => React.ReactNode }) => <div className="table-scroll"><table><thead><tr><th>平台</th><th>名称</th><th>Key</th><th>状态</th><th>QPS</th><th>今日用量</th><th>配额组</th><th>最近成功</th>{actions && <th>操作</th>}</tr></thead><tbody>{values.map((item) => <tr key={item.id}><td>{item.provider}</td><td>{item.label}</td><td><code>{item.mask}</code></td><td><span className={`badge ${item.status}`}>{item.status}</span></td><td>{item.qpsLimit}</td><td>{item.usedToday}/{item.dailyLimit}</td><td>{item.quotaScopeId}</td><td>{dateTime(item.lastSuccessAt)}</td>{actions && <td className="row-actions">{actions(item)}</td>}</tr>)}</tbody></table>{!values.length && <p className="admin-empty">暂无记录</p>}</div>;
const TokenTable = ({ values, revoke }: { values: Array<Record<string, unknown>>; revoke: (id: string) => void }) => <div className="table-scroll"><table><thead><tr><th>名称</th><th>前缀</th><th>权限</th><th>每分钟</th><th>到期</th><th>最后使用</th><th>状态</th><th>操作</th></tr></thead><tbody>{values.map((item) => <tr key={String(item.id)}><td>{String(item.name)}</td><td><code>{String(item.token_prefix)}</code></td><td>{Array.isArray(item.scopes) ? item.scopes.join(', ') : '-'}</td><td>{String(item.rate_limit_per_minute)}</td><td>{dateTime(item.expires_at)}</td><td>{dateTime(item.last_used_at)}</td><td>{item.revoked_at ? '已撤销' : '有效'}</td><td className="row-actions"><button className="danger" disabled={Boolean(item.revoked_at)} onClick={() => revoke(String(item.id))}>撤销</button></td></tr>)}</tbody></table>{!values.length && <p className="admin-empty">暂无记录</p>}</div>;
const JsonTable = ({ values }: { values: Array<Record<string, unknown>> }) => <div className="table-scroll"><table><thead><tr>{Object.keys(values[0] || {}).filter((key) => !['target','progress','details'].includes(key)).map((key) => <th key={key}>{key}</th>)}</tr></thead><tbody>{values.map((row, index) => <tr key={String(row.id || index)}>{Object.entries(row).filter(([key]) => !['target','progress','details'].includes(key)).map(([key, value]) => <td key={key}>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '-')}</td>)}</tr>)}</tbody></table>{!values.length && <p className="admin-empty">暂无记录</p>}</div>;
