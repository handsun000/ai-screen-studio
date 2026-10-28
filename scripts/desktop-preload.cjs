const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isDesktop: true,
  setTheme: (theme) => {
    ipcRenderer.send("desktop:set-theme", theme);
  },
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.setAttribute("data-desktop", "true");
  const savedTheme =
    localStorage.getItem("screen_demo_theme") ||
    document.documentElement.getAttribute("data-theme") ||
    "light";
  ipcRenderer.send("desktop:set-theme", savedTheme);
});
