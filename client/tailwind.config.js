/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}', './public/index.html'],
  theme: {
    extend: {
      colors: {
        gold: '#D4AF37',
        'gold-light': '#E8CD6E',
        'gold-dark': '#B8962E',
        model: {
          canvas: '#EFEFEB',
          surface: '#FAFAF7',
          ink: '#20211F',
          muted: '#62645F',
          line: '#DCDDD7',
          coral: '#DF6F60',
          'coral-ink': '#A64F43',
          sage: '#B8D9C9',
          butter: '#EFE4A2',
          mist: '#CBD8DF',
        },
      },
    },
  },
  plugins: [],
};
