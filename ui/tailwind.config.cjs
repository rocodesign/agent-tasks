/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Geist", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      // Fleet's hand-tuned dark palette (exact values from the design canvas)
      colors: {
        surface: {
          DEFAULT: "#0a0a0a", // app background
          1: "#0f0f0f", // gate input
          2: "#141414", // sidebar search / subtle hover
          3: "#161616", // key-button hover
          card: "#171717", // card / gate base (used with alpha)
        },
        edge: {
          1: "#1c1c1c", // structural dividers / selected row
          2: "#262626", // card & input borders
          3: "#2a2a2a", // subtle borders (key btn, ended pill)
        },
        fg: {
          1: "#fafafa",
          2: "#e5e5e5",
          3: "#cfcfcf",
          4: "#a3a3a3",
          5: "#9a9a9a",
          6: "#6e6e6e",
          7: "#585858",
          8: "#525252",
        },
      },
      keyframes: {
        "pulse-soft": {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: ".35" },
        },
        "live-dot": {
          "0%": { boxShadow: "0 0 0 0 rgba(52,211,153,.55)" },
          "70%": { boxShadow: "0 0 0 5px rgba(52,211,153,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(52,211,153,0)" },
        },
      },
      animation: {
        "pulse-soft": "pulse-soft 1.6s ease-in-out infinite",
        "live-dot": "live-dot 2s ease-out infinite",
      },
    },
  },
  plugins: [],
};
