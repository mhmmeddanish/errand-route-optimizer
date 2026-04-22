# AI Errand Route Optimizer

An intelligent errand planning application that optimizes multi-stop routes based on real-world constraints — not just shortest distance. Built as a semester-long HCI project exploring Human-AI interaction, trust, and transparency in AI-assisted decision making.

## The Problem

Existing navigation apps like Google Maps optimize errands by distance alone. They don't consider that your post office closes at 5 PM, your frozen groceries are melting in the car, or you want the car wash to be your last stop. This app fills that gap.

## Key Features

- **Smart Starting Point** — Use GPS or type any address. The app geocodes it and calculates all distances from your actual location.
- **Real Place Discovery** — Browse nearby businesses by category (Grocery, Pharmacy, Banking, etc.) powered by Google Places API with real names, addresses, hours, and ratings.
- **Search Any Place** — Type "Starbucks" or "CVS" and find real locations near you with full data.
- **Customizable AI Priorities** — Choose what the optimizer considers:
  - Store closing times (urgent stops first)
  - Perishable items (delay grocery runs to minimize car time)
  - Keep last (car wash stays final)
  - Shortest distance
  - Parking difficulty
- **Transparent AI Reasoning** — Every stop shows a plain-language explanation of why the AI ordered it that way. Users can see exactly how their priorities shaped the route.
- **Manual Override** — Drag-to-reorder lets users adjust the AI's suggestion based on personal knowledge.
- **Real-Time Updates** — Toggle priorities on/off and watch the route re-optimize instantly with updated reasoning.
- **Live Map** — Interactive Leaflet map with numbered stop markers and route visualization.
- **Navigation Handoff** — "Start Trip" opens Apple Maps or Google Maps with all stops as waypoints in the optimized order.

## Design Philosophy

This project is grounded in HCI principles:

- **Visibility** (Don Norman) — Store hours displayed directly on each place card so users don't need to look them up separately.
- **Trust through Transparency** — AI reasoning is shown for every decision, addressing the core challenge of Human-AI interaction.
- **User Agency** — The AI suggests, but the user controls. Manual reordering and toggleable priorities ensure the app functions as a decision-support tool, not a decision-maker.

## Tech Stack

- **Frontend:** React 18 + Vite
- **Maps:** Leaflet with CartoDB Voyager tiles
- **APIs:** Google Places API (nearby search, text search), Google Geocoding API
- **Styling:** Inline styles with Instrument Sans typography
- **Navigation:** Deep links to Apple Maps and Google Maps

## Setup

### Prerequisites

- Node.js v18+
- A Google Cloud API key with Places API and Geocoding API enabled

### Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/errand-route-optimizer.git
cd errand-route-optimizer

# Install dependencies
npm install

# Run development server
npm run dev
```

Open `http://localhost:5173` in your browser.

### API Key

The app uses a Google Maps API key configured in `src/App.jsx`. To use your own key:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable **Places API** and **Geocoding API**
3. Create an API key under Credentials
4. Replace the `GKEY` value at the top of `src/App.jsx`

The Vite dev server proxies API requests through `vite.config.js` to avoid CORS issues.

## Project Structure

```
errand-route-optimizer/
├── index.html
├── package.json
├── vite.config.js          # Proxy config for Google APIs
├── src/
│   ├── main.jsx            # App entry point
│   └── App.jsx             # Main application (all screens + logic)
├── reflection.md           # 300-word design reflection
└── README.md
```

## Design Evolution

| Phase | What Changed |
|-------|-------------|
| **Proposal** | Initial concept — AI route optimizer with store hours awareness |
| **Mid-Semester** | 3 Figma wireframes, user testing with Abhi, survey (10 respondents) |
| **Feedback** | Prof. Dym requested more visuals, optimization beyond timeliness |
| **Final** | Working React app, Google Places API, priority system, real maps, navigation handoff |

## User Testing

- **Moderated Interview** — Prototype walkthrough with a participant. Key finding: users need to see AI reasoning to trust the suggested order.
- **Survey** — 10 respondents from the Northeastern community on errand habits, AI trust, and feature preferences.

## Course

IS 4300: Human-Computer Interaction — Northeastern University, Spring 2026

## Author

Danish — Northeastern University