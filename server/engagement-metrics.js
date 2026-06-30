function engagementLabel(percent) {
  if (percent >= 10) return 'Viral';
  if (percent >= 5) return 'Good';
  if (percent >= 2) return 'Average';
  return 'Low';
}

function calcViewER(likes, comments, views) {
  if (!views || views <= 0) return { er_percent: 0, er_label: null };
  const er = (((Number(likes) || 0) + (Number(comments) || 0)) / views) * 100;
  const er_percent = Math.round(er * 100) / 100;
  return { er_percent, er_label: engagementLabel(er_percent) };
}

function median(values) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function enrichViewsVsMedian(posts, mediansByAccount) {
  return posts.map((post) => {
    const medianViews = mediansByAccount[post.account_handle] || null;
    const viewCount = Number(post.view_count) || 0;
    const viewsVsMedian = medianViews && viewCount > 0
      ? Math.round((viewCount / medianViews) * 100) / 100
      : null;
    return {
      ...post,
      account_median_views: medianViews,
      views_vs_median: viewsVsMedian,
    };
  });
}

async function medianViewsByAccount(pool, handles) {
  const uniqueHandles = [...new Set(handles.filter(Boolean))];
  if (uniqueHandles.length === 0) return {};

  const medians = {};
  for (const handle of uniqueHandles) {
    const result = await pool.query(
      `SELECT view_count FROM posts
       WHERE account_handle = $1
         AND view_count IS NOT NULL
         AND view_count > 0
         AND (archived = 0 OR archived IS NULL)
         AND (soft_deleted = 0 OR soft_deleted IS NULL)`,
      [handle]
    );
    medians[handle] = median(result.rows.map((row) => row.view_count));
  }
  return medians;
}

module.exports = {
  calcViewER,
  engagementLabel,
  enrichViewsVsMedian,
  median,
  medianViewsByAccount,
};
