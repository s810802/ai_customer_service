import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import AgentService from './pages/AgentService';
import Layout from './components/Layout';

function App() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        setSession(session);
        setLoading(false);
      })
      .catch(err => {
        console.error('Initialization error:', err);
        setInitError('系統初始化失敗，請檢查 Netlify 環境變數是否設定正確。');
        setLoading(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 text-gray-500">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          <p className="text-lg font-medium">系統載入中...</p>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="flex items-center justify-center h-screen bg-red-50 text-red-600 p-4 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-bold mb-2">發生錯誤</h1>
          <p>{initError}</p>
          <p className="text-sm mt-4 text-gray-500">請確認 VITE_SUPABASE_URL 與 VITE_SUPABASE_ANON_KEY 已正確填入 Netlify 控制台。</p>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={!session ? <Login /> : <Navigate to="/" />} />
        <Route element={session ? <Layout /> : <Navigate to="/login" />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agent" element={<AgentService />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;