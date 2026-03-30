package qianqian

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/utils"
)

const (
	AppID     = "16073360"
	Secret    = "0b50b02fd0d73a9c4c8c3a781c30845f"
	UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
	Referer   = "https://music.91q.com/player"
)

type Qianqian struct {
	cookie string
}

func New(cookie string) *Qianqian { return &Qianqian{cookie: cookie} }

var defaultQianqian = New("")

func Search(keyword string) ([]model.Song, error) { return defaultQianqian.Search(keyword) }
func SearchPlaylist(keyword string) ([]model.Playlist, error) {
	return defaultQianqian.SearchPlaylist(keyword)
}                                                      // [新增]
func GetPlaylistSongs(id string) ([]model.Song, error) { return defaultQianqian.GetPlaylistSongs(id) } // [新增]
func GetDownloadURL(s *model.Song) (string, error)     { return defaultQianqian.GetDownloadURL(s) }
func GetLyrics(s *model.Song) (string, error)          { return defaultQianqian.GetLyrics(s) }
func Parse(link string) (*model.Song, error)           { return defaultQianqian.Parse(link) }

// Search 搜索歌曲
func (q *Qianqian) Search(keyword string) ([]model.Song, error) {
	params := url.Values{}
	params.Set("word", keyword)
	params.Set("type", "1")
	params.Set("pageNo", "1")
	params.Set("pageSize", "10")
	params.Set("appid", AppID)
	signParams(params)
	apiURL := "https://music.91q.com/v1/search?" + params.Encode()

	body, err := utils.Get(apiURL,
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", Referer),
		utils.WithHeader("Cookie", q.cookie),
	)
	if err != nil {
		return nil, err
	}

	var resp struct {
		Data struct {
			TypeTrack []struct {
				TSID       string `json:"TSID"`
				Title      string `json:"title"`
				AlbumTitle string `json:"albumTitle"`
				Pic        string `json:"pic"`
				Duration   int    `json:"duration"`
				Lyric      string `json:"lyric"`
				Artist     []struct {
					Name string `json:"name"`
				} `json:"artist"`
				RateFileInfo map[string]struct {
					Size   int64  `json:"size"`
					Format string `json:"format"`
				} `json:"rateFileInfo"`
				IsVip int `json:"isVip"`
			} `json:"typeTrack"`
		} `json:"data"`
	}

	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("qianqian json parse error: %w", err)
	}

	var songs []model.Song
	for _, item := range resp.Data.TypeTrack {
		if item.IsVip != 0 {
			continue
		}
		var artistNames []string
		for _, ar := range item.Artist {
			artistNames = append(artistNames, ar.Name)
		}

		var size int64
		var bitrate int

		rates := []string{"3000", "320", "128", "64"}
		for _, r := range rates {
			if info, ok := item.RateFileInfo[r]; ok && info.Size > 0 {
				size = info.Size
				if item.Duration > 0 {
					bitrate = int(size * 8 / 1000 / int64(item.Duration))
				} else {
					if r == "3000" {
						bitrate = 800
					} else {
						bitrate, _ = strconv.Atoi(r)
					}
				}
				break
			}
		}

		songs = append(songs, model.Song{
			Source:   "qianqian",
			ID:       item.TSID,
			Name:     item.Title,
			Artist:   strings.Join(artistNames, "、"),
			Album:    item.AlbumTitle,
			Duration: item.Duration,
			Size:     size,
			Bitrate:  bitrate,
			Cover:    item.Pic,
			Link:     fmt.Sprintf("https://music.91q.com/song/%s", item.TSID),
			Extra: map[string]string{
				"tsid": item.TSID,
			},
		})
	}
	return songs, nil
}

// SearchPlaylist 搜索歌单
func (q *Qianqian) SearchPlaylist(keyword string) ([]model.Playlist, error) {
	// [参数修正] timestamp 是必须的，type=6 代表歌单 (之前可能用了 10000 导致报错)
	params := url.Values{}
	params.Set("word", keyword)
	params.Set("type", "6") // 6 = 歌单
	params.Set("pageNo", "1")
	params.Set("pageSize", "10")
	params.Set("appid", AppID)
	params.Set("timestamp", strconv.FormatInt(time.Now().Unix(), 10))

	// 签名参数 (Search 接口通常也需要签名)
	signParams(params)

	apiURL := "https://music.91q.com/v1/search?" + params.Encode()

	body, err := utils.Get(apiURL,
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", Referer),
		utils.WithHeader("Cookie", q.cookie),
	)
	if err != nil {
		return nil, err
	}

	// [结构修正] 兼容处理 Data 字段
	// 成功时 Data 是对象，失败或空时 Data 可能是空数组 []
	// 我们先定义一个外层结构检查 State
	var rawResp struct {
		State bool            `json:"state"`
		Errno int             `json:"errno"`
		Msg   string          `json:"errmsg"`
		Data  json.RawMessage `json:"data"` // 延迟解析
	}

	if err := json.Unmarshal(body, &rawResp); err != nil {
		return nil, fmt.Errorf("qianqian playlist json parse error: %w", err)
	}

	if !rawResp.State {
		// 如果 API 返回失败，通常 Data 是 []，直接返回空或错误
		// 忽略 "没有结果" 的错误，返回空列表
		return nil, nil // 或者 fmt.Errorf("api error: %s", rawResp.Msg)
	}

	// 解析 Data 部分
	var dataObj struct {
		TypeSonglist []struct {
			ID         interface{} `json:"id"` // 有时是 int 有时是 string，兼容一下
			Title      string      `json:"title"`
			Pic        string      `json:"pic"`
			TrackCount int         `json:"trackCount"`
			Tag        string      `json:"tag"`
		} `json:"typeSonglist"`
	}

	// 尝试将 RawMessage 解析为对象
	if err := json.Unmarshal(rawResp.Data, &dataObj); err != nil {
		// 如果解析失败，可能是因为 Data 是 [] (空结果)
		return nil, nil
	}

	var playlists []model.Playlist
	for _, item := range dataObj.TypeSonglist {
		// ID 转换
		var id string
		switch v := item.ID.(type) {
		case float64:
			id = strconv.FormatInt(int64(v), 10)
		case string:
			id = v
		default:
			continue
		}

		playlists = append(playlists, model.Playlist{
			Source:      "qianqian",
			ID:          id,
			Name:        item.Title,
			Cover:       item.Pic,
			TrackCount:  item.TrackCount,
			Description: item.Tag,
			// 千千搜索结果不返回 Creator，留空
		})
	}

	return playlists, nil
}

// GetPlaylistSongs 获取歌单详情（解析歌曲列表）
func (q *Qianqian) GetPlaylistSongs(id string) ([]model.Song, error) {
	params := url.Values{}
	params.Set("id", id) // 歌单 ID
	params.Set("appid", AppID)
	// [关键修正] 接口路径改为 v1/tracklist/info，原 songlist/info 已 404
	params.Set("type", "0") // 0通常代表默认列表，有些情况可能需要此参数
	signParams(params)
	
	apiURL := "https://music.91q.com/v1/tracklist/info?" + params.Encode()

	body, err := utils.Get(apiURL,
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", Referer),
		utils.WithHeader("Cookie", q.cookie),
	)
	if err != nil {
		return nil, err
	}

	// 定义响应结构
	var resp struct {
		Data struct {
			// 注意：tracklist/info 接口返回的字段通常是 trackList
			TrackList []struct {
				TSID       string `json:"TSID"` // 歌曲 ID
				Title      string `json:"title"`
				AlbumTitle string `json:"albumTitle"`
				Pic        string `json:"pic"`
				Duration   int    `json:"duration"`
				Artist     []struct {
					Name string `json:"name"`
				} `json:"artist"`
				IsVip int `json:"isVip"`
			} `json:"trackList"`
		} `json:"data"`
		// 错误处理字段
		Errno  int    `json:"errno"`
		ErrMsg string `json:"errmsg"`
	}

	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("qianqian playlist detail json error: %w", err)
	}

	if resp.Errno != 0 && resp.Errno != 22000 { // 22000 sometimes implies success with empty data
		return nil, fmt.Errorf("api error: %s (code %d)", resp.ErrMsg, resp.Errno)
	}

	var songs []model.Song
	for _, item := range resp.Data.TrackList {
		// 过滤掉需要 VIP 的歌曲，或者虽然列出但无法播放的
		// if item.IsVip != 0 { continue } 

		var artistNames []string
		for _, ar := range item.Artist {
			artistNames = append(artistNames, ar.Name)
		}

		songs = append(songs, model.Song{
			Source:   "qianqian",
			ID:       item.TSID,
			Name:     item.Title,
			Artist:   strings.Join(artistNames, "、"),
			Album:    item.AlbumTitle,
			Duration: item.Duration,
			Cover:    item.Pic,
			// 构造网页链接
			Link:     fmt.Sprintf("https://music.91q.com/song/%s", item.TSID),
			Extra: map[string]string{
				"tsid": item.TSID,
			},
		})
	}

	if len(songs) == 0 {
		return nil, errors.New("playlist is empty or invalid")
	}

	return songs, nil
}

// Parse 解析链接并获取完整信息
func (q *Qianqian) Parse(link string) (*model.Song, error) {
	// 1. 提取 TSID
	re := regexp.MustCompile(`music\.91q\.com/song/(\w+)`)
	matches := re.FindStringSubmatch(link)
	if len(matches) < 2 {
		return nil, errors.New("invalid qianqian link")
	}
	tsid := matches[1]

	// 2. 获取 Metadata (通过 song/info 接口)
	song, err := q.fetchSongInfo(tsid)
	if err != nil {
		return nil, err
	}

	// 3. 获取下载链接 (直接调用 fetchDownloadURL)
	url, err := q.fetchDownloadURL(tsid)
	if err == nil {
		song.URL = url
	}

	return song, nil
}

// GetDownloadURL 获取下载链接
func (q *Qianqian) GetDownloadURL(s *model.Song) (string, error) {
	if s.Source != "qianqian" {
		return "", errors.New("source mismatch")
	}
	if s.URL != "" {
		return s.URL, nil
	}

	tsid := s.ID
	if s.Extra != nil && s.Extra["tsid"] != "" {
		tsid = s.Extra["tsid"]
	}

	return q.fetchDownloadURL(tsid)
}

// fetchDownloadURL 内部方法：获取下载链接
func (q *Qianqian) fetchDownloadURL(tsid string) (string, error) {
	qualities := []string{"3000", "320", "128", "64"}
	for _, rate := range qualities {
		params := url.Values{}
		params.Set("TSID", tsid)
		params.Set("appid", AppID)
		params.Set("rate", rate)
		signParams(params)
		apiURL := "https://music.91q.com/v1/song/tracklink?" + params.Encode()

		body, err := utils.Get(apiURL,
			utils.WithHeader("User-Agent", UserAgent),
			utils.WithHeader("Referer", Referer),
			utils.WithHeader("Cookie", q.cookie),
		)
		if err != nil {
			continue
		}

		var resp struct {
			Data struct {
				Path           string `json:"path"`
				Format         string `json:"format"`
				Size           int64  `json:"size"`
				Duration       int    `json:"duration"`
				TrailAudioInfo struct {
					Path string `json:"path"`
				} `json:"trail_audio_info"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			continue
		}
		downloadURL := resp.Data.Path
		if downloadURL == "" {
			downloadURL = resp.Data.TrailAudioInfo.Path
		}
		if downloadURL != "" {
			return downloadURL, nil
		}
	}
	return "", errors.New("download url not found")
}

// fetchSongInfo 内部方法：获取元数据
func (q *Qianqian) fetchSongInfo(tsid string) (*model.Song, error) {
	params := url.Values{}
	params.Set("TSID", tsid)
	params.Set("appid", AppID)
	signParams(params)
	apiURL := "https://music.91q.com/v1/song/info?" + params.Encode()

	body, err := utils.Get(apiURL,
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", Referer),
		utils.WithHeader("Cookie", q.cookie),
	)
	if err != nil {
		return nil, err
	}

	// 该接口不仅返回 lyric，还返回歌曲基本信息，虽然结构体需要扩展
	var resp struct {
		Data []struct {
			Title      string `json:"title"`
			AlbumTitle string `json:"albumTitle"`
			Pic        string `json:"pic"`
			Duration   int    `json:"duration"`
			Artist     []struct {
				Name string `json:"name"`
			} `json:"artist"`
			Lyric string `json:"lyric"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("qianqian song info parse error: %w", err)
	}
	if len(resp.Data) == 0 {
		return nil, errors.New("song info not found")
	}

	item := resp.Data[0]
	var artistNames []string
	for _, ar := range item.Artist {
		artistNames = append(artistNames, ar.Name)
	}

	return &model.Song{
		Source:   "qianqian",
		ID:       tsid,
		Name:     item.Title,
		Artist:   strings.Join(artistNames, "、"),
		Album:    item.AlbumTitle,
		Duration: item.Duration,
		Cover:    item.Pic,
		Link:     fmt.Sprintf("https://music.91q.com/song/%s", tsid),
		Extra: map[string]string{
			"tsid": tsid,
		},
	}, nil
}

// GetLyrics 获取歌词
func (q *Qianqian) GetLyrics(s *model.Song) (string, error) {
	if s.Source != "qianqian" {
		return "", errors.New("source mismatch")
	}

	tsid := s.ID
	if s.Extra != nil && s.Extra["tsid"] != "" {
		tsid = s.Extra["tsid"]
	}

	params := url.Values{}
	params.Set("TSID", tsid)
	params.Set("appid", AppID)
	signParams(params)
	apiURL := "https://music.91q.com/v1/song/info?" + params.Encode()

	body, err := utils.Get(apiURL,
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Referer", Referer),
		utils.WithHeader("Cookie", q.cookie),
	)
	if err != nil {
		return "", err
	}

	var resp struct {
		Data []struct {
			Lyric string `json:"lyric"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("qianqian song info parse error: %w", err)
	}
	if len(resp.Data) == 0 || resp.Data[0].Lyric == "" {
		return "", errors.New("lyric url not found")
	}

	lyricURL := resp.Data[0].Lyric
	lrcBody, err := utils.Get(lyricURL,
		utils.WithHeader("User-Agent", UserAgent),
		utils.WithHeader("Cookie", q.cookie),
	)
	if err != nil {
		return "", fmt.Errorf("download lyric failed: %w", err)
	}
	return string(lrcBody), nil
}

func signParams(v url.Values) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	v.Set("timestamp", timestamp)
	keys := make([]string, 0, len(v))
	for k := range v {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var buf strings.Builder
	for i, k := range keys {
		if i > 0 {
			buf.WriteString("&")
		}
		buf.WriteString(k)
		buf.WriteString("=")
		buf.WriteString(v.Get(k))
	}
	buf.WriteString(Secret)
	hash := md5.Sum([]byte(buf.String()))
	sign := hex.EncodeToString(hash[:])
	v.Set("sign", sign)
}
