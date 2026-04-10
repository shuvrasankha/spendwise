# 💰 SpendWise - Smart Expense & Income Tracker

A modern, full-featured expense tracking application built with vanilla JavaScript, Firebase, and Firestore. Track every rupee effortlessly with AI-powered insights, debt management, and comprehensive transaction history.

🌐 **Live App:** https://spendwise-sp.netlify.app

## ✨ Features

### 📊 Dashboard & Analytics
- Real-time expense & income tracking with daily/weekly/monthly/yearly views
- Interactive spending analytics with visual charts
- AI-powered insights for better financial decisions
- Smart categorization of expenses and income sources

### 💸 Transaction Management
- Quick expense entry with multiple payment methods (UPI, Cash, Cards, Net Banking)
- Income source tracking with bank/wallet details
- Edit and delete transactions with confirmation dialogs
- CSV export functionality for record-keeping and tax filing

### 💳 Debt Tracker
- Track money you owe and money others owe you
- Settle debts with confirmation workflow
- Reactivate settled debts if needed
- Clear visual summary of outstanding balances

### 🎨 User Experience
- 🌓 Dark/Light mode with smooth transitions
- 📱 Fully responsive design (mobile, tablet, desktop)
- 🎯 Mobile-optimized bottom sheets for forms and modals
- 🔍 Advanced filtering by date, category, payment method, and search
- 🗂️ Tab-based navigation for expenses and income history
- ✅ Icon-only action buttons for cleaner interface

### 🔐 Security & Privacy
- Secure authentication with Email/Password and Google Sign-In
- Client-side XOR encryption for sensitive fields
- Firestore rules restrict access to user's own data only

### 🌐 Offline Support
- Offline queue for saving transactions without internet
- Auto-sync when connection is restored
- Pending transaction indicator

### 🎙️ Voice Commands
- Voice-powered transaction entry with AI parsing
- Natural language input support
- Multi-language support

## 🛠️ Technologies Used

| Category | Technology |
|----------|-----------|
| **Frontend** | HTML5, CSS3, Vanilla JavaScript (ES6+) |
| **Backend** | Firebase & Firestore (NoSQL database) |
| **Authentication** | Firebase Auth (Email/Password, Google OAuth) |
| **Charts** | Chart.js for data visualization |
| **Icons** | Lucide Icons |
| **AI/ML** | Hugging Face Inference API |
| **Deployment** | Netlify |
| **PWA** | Service Worker for offline support |

## 📱 Pages & Navigation

| Page | Description |
|------|-------------|
| **Dashboard** | Overview of monthly/yearly expenses, trends, and top categories |
| **Expense** | Add and manage expense transactions |
| **Income** | Track income sources and earnings |
| **History** | Complete transaction history with filters and export |
| **Debt Tracker** | Manage debts - money owed to you and money you owe |
| **AI Insights** | Get smart financial insights powered by AI |

## 🚀 Quick Start

1. **Sign Up/Login:** Create an account with email or Google Sign-In
2. **Add Expense/Income:** Fill in amount, category, date, payment method, and notes
3. **View Analytics:** Check your dashboard for spending patterns
4. **Track Debts:** Record and settle debts with people
5. **Get Insights:** Use AI insights to understand your spending habits
6. **Export Data:** Download transactions as CSV for record-keeping

## 📂 File Structure

```
spendwise/
├── index.html              # Dashboard page
├── expense.html            # Expense management
├── income.html             # Income tracking
├── history.html            # Transaction history
├── debt.html               # Debt tracker
├── insights.html           # AI insights page
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker
├── assets/
│   ├── css/
│   │   ├── tokens.css      # Design tokens (colors, spacing, typography)
│   │   ├── style.css       # Main styles
│   │   └── responsive.css  # Responsive breakpoints
│   ├── js/
│   │   ├── config/         # Firebase configuration
│   │   ├── modules/        # Feature modules (auth, offline, voice, etc.)
│   │   ├── utils/          # Helper utilities
│   │   ├── dashboard.js    # Dashboard logic
│   │   ├── income.js       # Income page logic
│   │   ├── debt.js         # Debt tracker logic
│   │   └── event-delegation.js  # Global event handlers
│   └── images/             # Logos and assets
└── README.md               # This file
```

## 🔒 Security

- ✅ User data isolated by authentication (uid-based access)
- ✅ Sensitive fields encrypted client-side (XOR encryption)
- ✅ Firestore security rules enforce user-level access
- ✅ No credentials stored in client code (Firebase config is public but rules-protected)
- ⚠️ Always use Firebase security rules in production

## 🌍 Browser Support

- ✅ Chrome/Edge (latest)
- ✅ Firefox (latest)
- ✅ Safari (latest)
- ✅ Mobile browsers (iOS Safari, Chrome Mobile, Samsung Internet)

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| App not loading | Clear browser cache and reload |
| Data not saving | Check internet connection; offline queue will sync later |
| Authentication errors | Verify email is verified; try Google Sign-In |
| Charts not showing | Ensure Chart.js CDN is accessible |
| Voice commands not working | Check microphone permissions; use Chrome/Edge for best support |

## 🗺️ Roadmap

- [ ] Budget setting and overspend alerts
- [ ] Receipt image uploads
- [ ] Recurring expense/income management
- [ ] Multi-currency support with auto-conversion
- [ ] Export to PDF reports
- [ ] Category-based spending limits
- [ ] Bill payment reminders

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is open source and available under the MIT License.

## 📬 Support

For questions, bug reports, or feature requests, please [open an issue](https://github.com/shuvrasankha/spendwise/issues) on GitHub.

---

**Made with ❤️ by Shuvrasankha Paul** | **Last Updated:** April 2026
