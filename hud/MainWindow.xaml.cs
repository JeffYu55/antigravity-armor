using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace ArmorHud
{
    public partial class MainWindow : Window
    {
        private readonly HttpClient _http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(6) };
        private readonly DispatcherTimer _timer = new DispatcherTimer();
        private string _token = "";
        private string _base = "http://127.0.0.1:50101";
        private bool _collapsed;
        private bool _suppressLane;
        private Forms.NotifyIcon _tray;
        private string _lastStatus = "";

        public MainWindow()
        {
            InitializeComponent();
            LoadToken();
            _http.DefaultRequestHeaders.Add("X-Armor-Token", _token);
            PositionDefault();
            SetupTray();
            _timer.Interval = TimeSpan.FromSeconds(2);
            _timer.Tick += async (s, e) => await RefreshAsync();
            _timer.Start();
            Loaded += async (s, e) => { await RefreshAsync(); await LoadSeatAsync(); };
        }

        private void LoadToken()
        {
            var fromEnv = Environment.GetEnvironmentVariable("AARMOR_HUD_TOKEN");
            if (!string.IsNullOrWhiteSpace(fromEnv)) { _token = fromEnv.Trim(); return; }
            var fromUrl = Environment.GetEnvironmentVariable("AARMOR_HUD_URL");
            if (!string.IsNullOrWhiteSpace(fromUrl)) _base = fromUrl.Trim().TrimEnd('/');

            string[] candidates =
            {
                Path.Combine(AppContext.BaseDirectory, "..", "..", "state", "hud", "token.txt"),
                Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "state", "hud", "token.txt"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Projects", "antigravity-armor-2.34", "state", "hud", "token.txt"),
            };
            foreach (var c in candidates)
            {
                try
                {
                    var p = Path.GetFullPath(c);
                    if (File.Exists(p)) { _token = File.ReadAllText(p).Trim(); return; }
                }
                catch { }
            }
        }

        private void PositionDefault()
        {
            var wa = SystemParameters.WorkArea;
            Left = wa.Right - Width - 24;
            Top = wa.Top + 64;
        }

        private void SetupTray()
        {
            try
            {
                _tray = new Forms.NotifyIcon
                {
                    Icon = System.Drawing.SystemIcons.Shield,
                    Text = "armor HUD",
                    Visible = true,
                };
                var menu = new Forms.ContextMenuStrip();
                menu.Items.Add("显示", null, (s, e) => Dispatcher.Invoke(() => { Show(); WindowState = WindowState.Normal; Activate(); }));
                menu.Items.Add("隐藏", null, (s, e) => Dispatcher.Invoke(Hide));
                menu.Items.Add("退出", null, (s, e) => Dispatcher.Invoke(Close));
                _tray.ContextMenuStrip = menu;
                _tray.MouseClick += (s, e) => { if (e.Button == Forms.MouseButtons.Left) Dispatcher.Invoke(() => { Show(); Activate(); }); };
            }
            catch { }
        }

        private async Task RefreshAsync()
        {
            try
            {
                var json = await _http.GetStringAsync(_base + "/api/state");
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                var verdict = "pass";
                var hasCtl = false;
                var streak = 0;
                var words = "";
                var inj = 0;
                var retry = 0;
                if (root.TryGetProperty("controller", out var ctl) && ctl.ValueKind == JsonValueKind.Object)
                {
                    hasCtl = true;
                    if (ctl.TryGetProperty("verdict", out var v) && v.ValueKind == JsonValueKind.String) verdict = v.GetString();
                    if (ctl.TryGetProperty("streak", out var st)) streak = st.GetInt32();
                    if (ctl.TryGetProperty("words", out var w) && w.ValueKind == JsonValueKind.Array && w.GetArrayLength() > 0) words = w[0].GetString();
                    if (ctl.TryGetProperty("interventions", out var itn))
                    {
                        if (itn.TryGetProperty("injections", out var i1)) inj = i1.GetInt32();
                        if (itn.TryGetProperty("retries", out var r1)) retry = r1.GetInt32();
                    }
                }

                string label;
                if (!hasCtl || verdict == null) label = "待判定";
                else if (verdict == "pass") label = "已交付";
                else if (verdict == "fallback") label = "软拒答";
                else if (verdict == "blocked") label = "网关拦截";
                else if (verdict == "truncated") label = "流截断";
                else if (verdict == "empty") label = "空响应";
                else label = "拒答";

                SetDot(verdict);
                StatusText.Text = "armor · " + label + (words != "" ? " (" + words + ")" : "") + (streak > 1 ? " · 连续" + streak : "") + (inj > 0 ? " · 纠正x" + inj : "") + (retry > 0 ? " · 重试x" + retry : "");

                var hostVersion = "?";
                if (root.TryGetProperty("host", out var host) && host.TryGetProperty("version", out var hv)) hostVersion = hv.GetString();

                var lane = "neutral";
                if (root.TryGetProperty("divert", out var dv) && dv.TryGetProperty("lane", out var lv)) lane = lv.GetString();
                _suppressLane = true;
                foreach (var obj in LaneBox.Items)
                {
                    if (obj is System.Windows.Controls.ComboBoxItem citem &&
                        string.Equals(citem.Content?.ToString(), lane, StringComparison.OrdinalIgnoreCase))
                    {
                        LaneBox.SelectedItem = citem;
                        break;
                    }
                }
                _suppressLane = false;

                var marks = "";
                if (root.TryGetProperty("layers", out var layers))
                {
                    marks += LayerMark(layers, "binary");
                    marks += LayerMark(layers, "ide");
                }
                SubText.Text = "宿主 " + hostVersion + " · 层 " + (marks == "" ? "—" : marks) + " · 车道 " + lane;
                LayerText.Text = "层 " + (marks == "" ? "—" : marks);

                if (root.TryGetProperty("queued", out var q) && q.ValueKind == JsonValueKind.Array)
                {
                    var n = q.GetArrayLength();
                    Hint.Text = n > 0 ? "队列 " + n + " 条待注入" : "队列空";
                }
                if (root.TryGetProperty("journal", out var j) && j.TryGetProperty("total", out var jt))
                {
                    var total = jt.GetInt32();
                    if (total > 0) Hint.Text = (Hint.Text ?? "") + " · 已记录 " + total + " 回合";
                }
                _lastStatus = "online";
            }
            catch
            {
                SetDot("offline");
                StatusText.Text = "armor · 控制面离线（跑 aarmor hud start）";
                SubText.Text = _base + " · token " + (_token.Length > 6 ? _token.Substring(0, 6) + "…" : "(缺失)");
                _lastStatus = "offline";
            }
        }

        private static string LayerMark(JsonElement layers, string name)
        {
            try
            {
                if (!layers.TryGetProperty(name, out var l)) return "○";
                if (l.TryGetProperty("armored", out var a) && a.GetBoolean()) return "●";
                if (l.TryGetProperty("patched", out var p) && p.GetBoolean()) return "●";
                return "○";
            }
            catch { return "○"; }
        }

        private void SetDot(string verdict)
        {
            Color color;
            if (verdict == "pass") color = Color.FromRgb(0x10, 0xB9, 0x81);
            else if (verdict == "refusal") color = Color.FromRgb(0xEF, 0x44, 0x44);
            else if (verdict == "offline") color = Color.FromRgb(0x8B, 0x94, 0x9E);
            else color = Color.FromRgb(0xF5, 0x9E, 0x0B);
            Dot.Fill = new SolidColorBrush(color);
            Shell.BorderBrush = new SolidColorBrush(Color.FromArgb(0x44, color.R, color.G, color.B));
        }

        private async Task LoadSeatAsync()
        {
            try
            {
                var json = await _http.GetStringAsync(_base + "/api/seat");
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("text", out var t)) SeatBox.Text = t.GetString();
            }
            catch { /* 离线时留空 */ }
        }

        private async Task PostAsync(string path, object payload, string okHint)
        {
            try
            {
                var body = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
                var res = await _http.PostAsync(_base + path, body);
                var txt = await res.Content.ReadAsStringAsync();
                if (!res.IsSuccessStatusCode)
                {
                    Hint.Text = "失败 " + (int)res.StatusCode + ": " + txt;
                    return;
                }
                Hint.Text = okHint;
                await RefreshAsync();
            }
            catch (Exception ex) { Hint.Text = "失败: " + ex.Message; }
        }

        private async void BtnApply_Click(object sender, RoutedEventArgs e)
            => await PostAsync("/api/seat", new { text = SeatBox.Text }, "已应用（每轮注入）");

        private async void BtnOnce_Click(object sender, RoutedEventArgs e)
            => await PostAsync("/api/inject", new { text = SeatBox.Text, mode = "once" }, "已排队（下一发生效）");

        private async void BtnTtl_Click(object sender, RoutedEventArgs e)
            => await PostAsync("/api/inject", new { text = SeatBox.Text, mode = "ttl", ttlSec = 600 }, "已排队（10 分钟内每轮生效）");

        private async void BtnReset_Click(object sender, RoutedEventArgs e)
        {
            await PostAsync("/api/seat/reset", new { }, "已恢复默认种子");
            await LoadSeatAsync();
        }

        private async void BtnProbe_Click(object sender, RoutedEventArgs e)
            => await PostAsync("/api/probe", new { attempts = 2 }, "已开始跑分（离线 mock）");

        private async void LaneBox_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
        {
            if (_suppressLane) return;
            var item = LaneBox.SelectedItem as System.Windows.Controls.ComboBoxItem;
            if (item == null) return;
            await PostAsync("/api/lane", new { lane = item.Content.ToString() }, "车道已切换");
        }

        private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState == MouseButtonState.Pressed) DragMove();
        }

        private void BtnCollapse_Click(object sender, RoutedEventArgs e)
        {
            _collapsed = !_collapsed;
            Body.Visibility = _collapsed ? Visibility.Collapsed : Visibility.Visible;
            SubText.Visibility = _collapsed ? Visibility.Collapsed : Visibility.Visible;
            Height = _collapsed ? 52 : 252;
            BtnCollapse.Content = _collapsed ? "▢" : "—";
        }

        private void BtnClose_Click(object sender, RoutedEventArgs e) => Hide();

        protected override void OnClosed(EventArgs e)
        {
            _timer.Stop();
            if (_tray != null) { _tray.Visible = false; _tray.Dispose(); }
            base.OnClosed(e);
        }
    }
}
