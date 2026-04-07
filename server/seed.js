const db = require('./db');

const seed = [
  {
    shortcode: 'CxFake001',
    video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    thumbnail_url: 'https://picsum.photos/seed/ig1/400/500',
    caption: 'POV: You finally launched your product after 6 months of building in silence. The DMs are flooding in. This is what consistency looks like. #startup #launch #entrepreneur',
    like_count: 48200,
    comment_count: 1340,
    view_count: 892000,
    posted_at: '2026-03-28T14:30:00Z',
    account_handle: 'garyvee',
    post_url: 'https://www.instagram.com/p/CxFake001/',
    tag: null,
    notes: '',
    source_query: 'garyvee',
  },
  {
    shortcode: 'CxFake002',
    video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    thumbnail_url: 'https://picsum.photos/seed/ig2/400/500',
    caption: 'The 5 AM morning routine that made me a millionaire before 30. Step 1: cold plunge. Step 2: journal. Step 3: deep work sprint. No excuses. #morningroutine #success',
    like_count: 127500,
    comment_count: 4200,
    view_count: 2100000,
    posted_at: '2026-03-15T08:00:00Z',
    account_handle: 'hormozi',
    post_url: 'https://www.instagram.com/p/CxFake002/',
    tag: 'recreate',
    notes: 'Great hook, recreate with our brand angle',
    source_query: 'hormozi',
  },
  {
    shortcode: 'CxFake003',
    video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    thumbnail_url: 'https://picsum.photos/seed/ig3/400/500',
    caption: 'Ugly ads convert better. Here\'s proof from our last 3 campaigns. Swipe to see the data. Stop overproducing content. #marketing #ads #ugc',
    like_count: 34800,
    comment_count: 890,
    view_count: 654000,
    posted_at: '2026-04-01T11:15:00Z',
    account_handle: 'marketingharry',
    post_url: 'https://www.instagram.com/p/CxFake003/',
    tag: 'reference',
    notes: '',
    source_query: '#marketing',
  },
  {
    shortcode: 'CxFake004',
    video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    thumbnail_url: 'https://picsum.photos/seed/ig4/400/500',
    caption: 'I asked ChatGPT to roast my landing page. It was brutal but it was right. Here\'s every change I made and the conversion lift we saw. Thread below. #ai #conversion',
    like_count: 71000,
    comment_count: 2100,
    view_count: 1340000,
    posted_at: '2026-03-20T16:45:00Z',
    account_handle: 'garyvee',
    post_url: 'https://www.instagram.com/p/CxFake004/',
    tag: null,
    notes: '',
    source_query: 'garyvee',
  },
  {
    shortcode: 'CxFake005',
    video_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    thumbnail_url: 'https://picsum.photos/seed/ig5/400/500',
    caption: 'Stop posting 3x a day. Post once and make it count. Here\'s our content framework that gets 10x more reach with half the effort. Save this. #contentstrategy #reels',
    like_count: 95600,
    comment_count: 3400,
    view_count: 1780000,
    posted_at: '2026-04-03T09:30:00Z',
    account_handle: 'hormozi',
    post_url: 'https://www.instagram.com/p/CxFake005/',
    tag: 'recreate',
    notes: 'Framework angle is strong — adapt for our niche',
    source_query: 'hormozi',
  },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO posts
    (shortcode, video_url, thumbnail_url, caption, like_count, comment_count, view_count, posted_at, account_handle, post_url, tag, notes, source_query)
  VALUES
    (@shortcode, @video_url, @thumbnail_url, @caption, @like_count, @comment_count, @view_count, @posted_at, @account_handle, @post_url, @tag, @notes, @source_query)
`);

const insertAll = db.transaction((posts) => {
  for (const post of posts) {
    insert.run(post);
  }
});

insertAll(seed);
console.log(`Seeded ${seed.length} posts.`);
