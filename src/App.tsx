/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  LayoutDashboard, 
  Target, 
  DollarSign, 
  Send, 
  MoreVertical, 
  Trash2, 
  Edit, 
  ChevronRight, 
  LogOut, 
  Sparkles,
  RefreshCw,
  TrendingUp,
  Share2,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  serverTimestamp, 
  doc, 
  updateDoc, 
  deleteDoc,
  Timestamp,
  orderBy,
  getDocFromServer
} from 'firebase/firestore';
import { auth, db } from './firebase';

// Types
interface TargetingStrategy {
  name: string;
  demographics: string;
  interests: string;
  behaviors: string;
}

interface Campaign {
  id: string;
  userId: string;
  title: string;
  platform: 'Instagram' | 'Facebook' | 'TikTok' | 'LinkedIn' | 'Twitter/X';
  budget: number;
  targetAudience: string;
  adCopy: string;
  strategy: string;
  targetingStrategies?: TargetingStrategy[];
  abTestPlan?: string;
  status: 'Draft' | 'Active' | 'Paused' | 'Completed';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

// Error handling for Firestore
const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
};

// --- AI Service ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const generateAdStrategy = async (title: string, platform: string, budget: number, audience: string) => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: `You are an expert social media advertising consultant. 
      The user wants to run an ad for "${title}" on ${platform}.
      Their budget is $${budget}.
      User-defined Audience context: ${audience}.
      
      Tasks:
      1. AI-generated Ad Copy: Engaging, short, platform-appropriate.
      2. Budget Strategy: How to spend that small budget for max impact (e.g., specific times, daily caps).
      3. 3 Distinct Audience Targeting Strategies: Each with specific demographics, interests, and behaviors.
      4. Basic A/B Testing Plan: Focus on testing one variable (e.g., image vs video) and how to interpret results.
      
      Format your response as a valid JSON object:
      {
        "adCopy": "string",
        "strategy": "string",
        "targetingStrategies": [
          { "name": "Strategy Name", "demographics": "...", "interests": "...", "behaviors": "..." },
          { "name": "Strategy Name", "demographics": "...", "interests": "...", "behaviors": "..." },
          { "name": "Strategy Name", "demographics": "...", "interests": "...", "behaviors": "..." }
        ],
        "abTestPlan": "string (concise paragraph)"
      }`,
      config: {
        responseMimeType: "application/json"
      }
    });
    
    return JSON.parse(response.text);
  } catch (error) {
    console.error("AI Generation Error:", error);
    return {
      adCopy: "Oops! We encountered an error generating your ad copy.",
      strategy: "Focus on peak hours.",
      targetingStrategies: [
        { name: "Broad Local", demographics: "Local city", interests: "General", behaviors: "All" }
      ],
      abTestPlan: "Test your headline first."
    };
  }
};

// --- Components ---

const ErrorBoundary: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      setHasError(true);
      try {
        const parsed = JSON.parse(event.error.message);
        setErrorMessage(parsed.error || "A database error occurred.");
      } catch {
        setErrorMessage(event.error.message || "An unexpected error occurred.");
      }
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-red-50 text-red-900 border-2 border-red-200">
        <AlertCircle size={48} className="mb-4" />
        <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
        <p className="text-center max-w-md mb-6">{errorMessage}</p>
        <button 
          onClick={() => window.location.reload()}
          className="px-6 py-2 bg-red-600 text-white rounded-full font-medium hover:bg-red-700 transition-colors"
        >
          Reload App
        </button>
      </div>
    );
  }

  return <>{children}</>;
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // Form State
  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState<Campaign['platform']>('Instagram');
  const [budget, setBudget] = useState(0);
  const [audience, setAudience] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsAuthReady(true);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady || !user) return;

    // Test connection
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. The client is offline.");
        }
      }
    };
    testConnection();

    const q = query(
      collection(db, 'campaigns'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Campaign));
      setCampaigns(docs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'campaigns');
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    setIsGenerating(true);
    const aiResult = await generateAdStrategy(title, platform, budget, audience);
    
    try {
      await addDoc(collection(db, 'campaigns'), {
        userId: user.uid,
        title,
        platform,
        budget,
        targetAudience: audience,
        adCopy: aiResult.adCopy,
        strategy: aiResult.strategy,
        status: 'Draft',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      setShowForm(false);
      resetForm();
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'campaigns');
    } finally {
      setIsGenerating(false);
    }
  };

  const resetForm = () => {
    setTitle('');
    setPlatform('Instagram');
    setBudget(0);
    setAudience('');
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this campaign?")) return;
    try {
      await deleteDoc(doc(db, 'campaigns', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `campaigns/${id}`);
    }
  };

  const updateStatus = async (id: string, newStatus: Campaign['status']) => {
    try {
      await updateDoc(doc(db, 'campaigns', id), {
        status: newStatus,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `campaigns/${id}`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#FDFCF9]">
        <div className="flex flex-col items-center">
          <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="mt-4 text-indigo-900/60 font-medium">Initializing BudgetAds AI...</p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-bg-main font-sans text-text-main selection:bg-accent/10 flex">
        {!user ? (
          <LandingPage onLogin={handleLogin} />
        ) : (
          <>
            {/* Sidebar */}
            <nav className="w-60 bg-sidebar text-white flex flex-col py-6 shrink-0 hidden md:flex">
              <div className="px-6 pb-10 flex items-center gap-2.5">
                <div className="w-6 h-6 bg-accent rounded flex items-center justify-center">
                  <Target size={14} className="text-white" />
                </div>
                <span className="text-xl font-bold tracking-tight">BudgetPulse</span>
              </div>
              
              <div className="flex flex-col flex-1">
                <SidebarItem icon={<LayoutDashboard size={18} />} label="Dashboard" active />
                <SidebarItem icon={<Share2 size={18} />} label="Campaigns" />
                <SidebarItem icon={<Target size={18} />} label="Audience Lab" />
                <SidebarItem icon={<Sparkles size={18} />} label="Creative Studio" />
                <SidebarItem icon={<TrendingUp size={18} />} label="Reporting" />
              </div>

              <div className="px-6 mt-auto">
                <button 
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 py-3 text-[#94a3b8] hover:text-white transition-colors text-sm"
                >
                  <LogOut size={18} />
                  Sign Out
                </button>
              </div>
            </nav>

            {/* Main Content */}
            <main className="flex-1 p-8 overflow-y-auto max-h-screen">
              <header className="flex justify-between items-center mb-10">
                <div>
                  <h1 className="text-2xl font-semibold">Dashboard Overview</h1>
                  <p className="text-sm text-text-muted mt-1">Manage your low-budget ad placements</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="bg-white border border-border-ui px-4 py-2 rounded-md text-sm text-text-muted shadow-sm">
                    {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                  <button 
                    onClick={() => setShowForm(true)}
                    className="bg-accent text-white px-5 py-2.5 rounded-lg font-medium shadow-sm hover:brightness-110 transition-all flex items-center gap-2"
                  >
                    <Plus size={18} />
                    New Campaign
                  </button>
                </div>
              </header>

              {/* Stats Grid */}
              <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-10">
                <StatCard label="Total Daily Budget" value={`$${campaigns.reduce((acc, c) => acc + c.budget, 0).toFixed(2)}`} delta="Total active spend" />
                <StatCard label="Active Ads" value={campaigns.filter(c => c.status === 'Active').length.toString()} delta="Growing reach" />
                <StatCard label="Drafts" value={campaigns.filter(c => c.status === 'Draft').length.toString()} delta="Pending launch" />
                <StatCard label="Avg. Daily Spend" value={`$${campaigns.length ? (campaigns.reduce((acc, c) => acc + c.budget, 0) / campaigns.length).toFixed(2) : "0.00"}`} delta="Per campaign" />
              </section>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                {/* Active Campaigns Panel */}
                <div className="xl:col-span-2 bg-white rounded-xl border border-border-ui shadow-sm overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-bottom border-border-ui border-b font-semibold text-[15px] flex justify-between items-center">
                    <span>Campaign List</span>
                    <span className="text-xs font-normal text-text-muted">{campaigns.length} total</span>
                  </div>
                  
                  <div className="overflow-x-auto">
                    {campaigns.length === 0 ? (
                      <div className="p-12 text-center text-text-muted italic">No campaigns yet. Create one to get started.</div>
                    ) : (
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-[#fafbfc] border-b border-border-ui">
                          <tr>
                            <th className="px-5 py-3 font-medium text-text-muted uppercase tracking-wider">Campaign Name</th>
                            <th className="px-5 py-3 font-medium text-text-muted uppercase tracking-wider">Platform</th>
                            <th className="px-5 py-3 font-medium text-text-muted uppercase tracking-wider">Daily Budget</th>
                            <th className="px-5 py-3 font-medium text-text-muted uppercase tracking-wider">Status</th>
                            <th className="px-5 py-3 font-medium text-text-muted uppercase tracking-wider text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border-ui">
                          {campaigns.map((campaign) => (
                            <CampaignTableRow 
                              key={campaign.id} 
                              campaign={campaign} 
                              onDelete={handleDelete}
                              onStatusChange={updateStatus}
                              onToggleExpand={() => {}}
                            />
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                {/* Smart Optimizations Panel */}
                <div className="bg-white rounded-xl border border-border-ui shadow-sm flex flex-col">
                  <div className="px-5 py-4 border-b border-border-ui font-semibold text-[15px]">Smart Optimizations</div>
                  <div className="flex flex-col divide-y divide-border-ui">
                    <OptimizationCard 
                      tag="BUDGET SAVER" 
                      title="Micro-Budget Strategy" 
                      desc="For budgets under $5, focus placements purely on Reels/Stories for higher engagement density." 
                    />
                    <OptimizationCard 
                      tag="CREATIVE" 
                      title="Short-Form Priority" 
                      desc="Video content under 15s is seeing 40% lower CPMs this week. Update your creative focus." 
                    />
                    <OptimizationCard 
                      tag="STRATEGY" 
                      title="Audience Refinement" 
                      desc="A niche segment in 'Local Interest' is showing high resonance. Consider spinning off a $1/day test." 
                    />
                  </div>
                </div>
              </div>
            </main>
          </>
        )}

        {/* Modal Form */}
        <AnimatePresence>
          {showForm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-12">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => !isGenerating && setShowForm(false)}
                className="absolute inset-0 bg-sidebar/40 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="relative bg-white w-full max-w-xl rounded-xl shadow-2xl border border-border-ui"
              >
                <div className="p-8">
                  <div className="flex items-center justify-between mb-8 border-b border-border-ui pb-4">
                    <h2 className="text-xl font-semibold tracking-tight">New Ad Campaign</h2>
                    <Sparkles className="text-accent" />
                  </div>

                  <form onSubmit={handleSubmit} className="space-y-5">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Campaign Title</label>
                      <input 
                        required
                        type="text" 
                        value={title} 
                        onChange={e => setTitle(e.target.value)}
                        placeholder="e.g. Summer Coffee Special"
                        className="w-full px-4 py-3 bg-bg-main border border-border-ui rounded-lg focus:border-accent focus:bg-white transition-all outline-none text-sm"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Platform</label>
                        <select 
                          value={platform}
                          onChange={e => setPlatform(e.target.value as Campaign['platform'])}
                          className="w-full px-4 py-3 bg-bg-main border border-border-ui rounded-lg focus:border-accent focus:bg-white transition-all outline-none appearance-none text-sm"
                        >
                          {['Instagram', 'Facebook', 'TikTok', 'LinkedIn', 'Twitter/X'].map(p => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Daily Budget ($)</label>
                        <input 
                          required
                          type="number" 
                          min="1"
                          value={budget || ''}
                          onChange={e => setBudget(Number(e.target.value))}
                          placeholder="e.g. 5"
                          className="w-full px-4 py-3 bg-bg-main border border-border-ui rounded-lg focus:border-accent focus:bg-white transition-all outline-none text-sm"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Target Audience</label>
                      <textarea 
                        required
                        value={audience}
                        onChange={e => setAudience(e.target.value)}
                        placeholder="e.g. Local students aged 18-24 interested in dark roast"
                        rows={3}
                        className="w-full px-4 py-3 bg-bg-main border border-border-ui rounded-lg focus:border-accent focus:bg-white transition-all outline-none resize-none text-sm"
                      />
                    </div>

                    <button 
                      type="submit"
                      disabled={isGenerating}
                      className="w-full bg-accent text-white font-bold py-4 rounded-lg shadow-md shadow-accent/10 flex items-center justify-center gap-3 transition-all hover:brightness-110 disabled:opacity-70"
                    >
                      {isGenerating ? (
                        <>
                          <RefreshCw className="animate-spin" size={18} />
                          AI Generating...
                        </>
                      ) : (
                        <>
                          <Send size={18} />
                          Launch Campaign
                        </>
                      )}
                    </button>
                  </form>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  );
}

// --- Sub-components ---

function SidebarItem({ icon, label, active = false }: { icon: React.ReactNode, label: string, active?: boolean }) {
  return (
    <a 
      href="#" 
      className={`px-6 py-3 flex items-center gap-3 text-sm transition-all border-l-4 ${
        active 
        ? 'bg-white/5 text-white border-accent' 
        : 'text-[#94a3b8] border-transparent hover:text-white hover:bg-white/5'
      }`}
    >
      {icon}
      {label}
    </a>
  );
}

function StatCard({ label, value, delta }: { label: string, value: string, delta: string }) {
  return (
    <div className="bg-white p-5 rounded-xl border border-border-ui shadow-sm">
      <div className="text-[11px] font-bold text-text-muted uppercase tracking-wider mb-2">{label}</div>
      <div className="text-2xl font-bold mb-1">{value}</div>
      <div className="text-[11px] text-success font-medium flex items-center gap-1">
        <TrendingUp size={12} />
        {delta}
      </div>
    </div>
  );
}

function OptimizationCard({ tag, title, desc }: { tag: string, title: string, desc: string }) {
  return (
    <div className="p-5">
      <span className="inline-block px-1.5 py-0.5 bg-[#fff9db] text-[#f08c00] text-[10px] font-bold rounded mb-1">{tag}</span>
      <div className="text-[13px] font-semibold mb-1">{title}</div>
      <div className="text-xs text-text-muted leading-relaxed mb-3">{desc}</div>
      <button className="text-[11px] font-medium text-text-main border border-border-ui px-3 py-1.5 rounded hover:bg-bg-main transition-colors">
        Apply Suggestion
      </button>
    </div>
  );
}

const CampaignTableRow: React.FC<{ 
  campaign: Campaign, 
  onDelete: (id: string) => any,
  onStatusChange: (id: string, s: Campaign['status']) => any,
  onToggleExpand: () => void
}> = ({ 
  campaign, 
  onDelete, 
  onStatusChange 
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr className="hover:bg-[#fafbfc] transition-colors group border-b border-border-ui last:border-0">
        <td className="px-5 py-4">
          <div className="flex items-center gap-3">
            <span className={`status-indicator ${campaign.status === 'Active' ? 'status-active' : campaign.status === 'Draft' ? 'status-draft' : 'status-paused'}`} />
            <span className="font-medium text-text-main">{campaign.title}</span>
          </div>
        </td>
        <td className="px-5 py-4">
          <span className={`platform-pill ${
            campaign.platform === 'Instagram' ? 'pill-ig' :
            campaign.platform === 'Facebook' ? 'pill-fb' :
            campaign.platform === 'TikTok' ? 'pill-tt' :
            campaign.platform === 'LinkedIn' ? 'pill-li' :
            'pill-tw'
          }`}>
            {campaign.platform}
          </span>
        </td>
        <td className="px-5 py-4 font-medium">${campaign.budget.toFixed(2)}</td>
        <td className="px-5 py-4">
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
            campaign.status === 'Active' ? 'bg-green-100 text-green-600' :
            campaign.status === 'Draft' ? 'bg-amber-100 text-amber-600' :
            'bg-gray-100 text-gray-500'
          }`}>
            {campaign.status}
          </span>
        </td>
        <td className="px-5 py-4 text-right">
          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button 
              onClick={() => setExpanded(!expanded)}
              className="p-1.5 text-text-muted hover:text-accent rounded transition-colors"
              title="View Strategy"
            >
              <Sparkles size={16} />
            </button>
            <button 
              onClick={() => onStatusChange(campaign.id, campaign.status === 'Active' ? 'Paused' : 'Active')}
              className="p-1.5 text-text-muted hover:text-success rounded transition-colors"
              title={campaign.status === 'Active' ? 'Pause' : 'Activate'}
            >
              <RefreshCw size={16} />
            </button>
            <button 
              onClick={() => onDelete(campaign.id)}
              className="p-1.5 text-text-muted hover:text-red-500 rounded transition-colors"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </td>
      </tr>
      <AnimatePresence>
        {expanded && (
          <tr>
            <td colSpan={5} className="bg-bg-main/50 px-5 py-0 overflow-hidden">
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="py-6 border-l-2 border-accent/20 ml-2"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pl-6">
                  <div>
                    <div className="text-[10px] font-bold text-accent uppercase tracking-widest mb-2">AI Generated Ad Copy</div>
                    <div className="bg-white p-4 rounded-lg border border-border-ui text-xs italic text-text-main leading-relaxed shadow-sm mb-6">
                      "{campaign.adCopy}"
                    </div>

                    <div className="text-[10px] font-bold text-accent uppercase tracking-widest mb-2">A/B Testing Plan</div>
                    <div className="bg-white p-4 rounded-lg border border-border-ui text-xs text-text-muted leading-relaxed shadow-sm">
                      {campaign.abTestPlan || "Test your primary visual element (Image vs Video) for 48 hours to identify the lowest CPC."}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold text-accent uppercase tracking-widest mb-2">Budget Strategy</div>
                    <div className="bg-white p-4 rounded-lg border border-border-ui text-xs text-text-muted leading-relaxed shadow-sm mb-6">
                      {campaign.strategy}
                    </div>

                    <div className="text-[10px] font-bold text-accent uppercase tracking-widest mb-2">Audience Targeting Strategies</div>
                    <div className="space-y-3">
                      {(campaign.targetingStrategies || []).map((s, idx) => (
                        <div key={idx} className="bg-white p-4 rounded-lg border border-border-ui shadow-sm">
                          <div className="text-xs font-bold text-text-main mb-1">{s.name}</div>
                          <div className="text-[10px] text-text-muted grid grid-cols-1 gap-1">
                            <div><span className="font-semibold">Demographics:</span> {s.demographics}</div>
                            <div><span className="font-semibold">Interests:</span> {s.interests}</div>
                            <div><span className="font-semibold">Behaviors:</span> {s.behaviors}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
};

function LandingPage({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 min-h-screen w-full">
      <div className="p-12 lg:p-24 flex flex-col justify-center bg-white">
        <div className="flex items-center gap-2.5 text-accent font-bold tracking-tight text-2xl mb-12">
          <div className="w-8 h-8 bg-accent rounded flex items-center justify-center">
            <Target size={18} className="text-white" />
          </div>
          BudgetPulse
        </div>
        
        <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-text-main mb-6 leading-[1.1]">
          Professional ads.<br />
          <span className="text-accent">Personalized strategy.</span>
        </h1>
        
        <p className="text-lg text-text-muted max-w-lg mb-12 font-normal leading-relaxed">
          The precision of an enterprise ad manager, built for small business budgets. Let AI handle the copy and allocation.
        </p>
        
        <button 
          onClick={onLogin}
          className="flex items-center justify-center gap-4 bg-accent text-white px-8 py-5 rounded-lg font-bold text-lg shadow-lg shadow-accent/20 hover:brightness-110 hover:-translate-y-0.5 transition-all w-fit"
        >
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/action/google.svg" className="w-6 h-6 bg-white rounded-full p-1" alt="" />
          Continue with Google
        </button>
      </div>
      
      <div className="bg-sidebar relative overflow-hidden hidden lg:flex items-center justify-center group">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,#0984e3_0%,transparent_70%)] opacity-20" />
        <div className="relative z-10 w-full max-w-lg px-12">
          <div className="bg-white p-8 rounded-2xl shadow-2xl border border-white/10">
            <div className="flex items-center justify-between mb-8 pb-4 border-b border-border-ui">
              <div className="font-bold text-text-muted text-[10px] uppercase tracking-widest">Live Campaign Data</div>
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 bg-red-400 rounded-full" />
                <div className="w-2.5 h-2.5 bg-amber-400 rounded-full" />
                <div className="w-2.5 h-2.5 bg-green-400 rounded-full" />
              </div>
            </div>
            
            <div className="space-y-6">
              <div className="h-4 bg-bg-main rounded w-3/4 animate-pulse" />
              <div className="h-4 bg-bg-main rounded w-full animate-pulse delay-75" />
              <div className="grid grid-cols-2 gap-4 pt-4">
                <div className="h-20 bg-accent/5 rounded-xl border border-accent/10" />
                <div className="h-20 bg-accent/5 rounded-xl border border-accent/10" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
