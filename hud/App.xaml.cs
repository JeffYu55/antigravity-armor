using System;
using System.IO;
using System.Windows;

namespace ArmorHud
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            var log = Path.Combine(Path.GetTempPath(), "armor-hud.log");
            try
            {
                File.AppendAllText(log, DateTime.Now.ToString("HH:mm:ss") + " OnStartup begin\n");
                var win = new MainWindow();
                File.AppendAllText(log, DateTime.Now.ToString("HH:mm:ss") + " MainWindow constructed\n");
                win.Show();
                File.AppendAllText(log, DateTime.Now.ToString("HH:mm:ss") + " Shown\n");
            }
            catch (Exception ex)
            {
                try { File.AppendAllText(log, DateTime.Now.ToString("HH:mm:ss") + " FATAL " + ex + "\n"); } catch { }
                Shutdown(1);
            }
        }
    }
}
