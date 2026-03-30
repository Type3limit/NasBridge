package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"

	"github.com/guohuiyuan/music-lib/bilibili"
	"github.com/guohuiyuan/music-lib/jamendo"
	"github.com/guohuiyuan/music-lib/kugou"
	"github.com/guohuiyuan/music-lib/migu"
	"github.com/guohuiyuan/music-lib/model"
	"github.com/guohuiyuan/music-lib/netease"
	"github.com/guohuiyuan/music-lib/provider"
	"github.com/guohuiyuan/music-lib/qq"
	"github.com/guohuiyuan/music-lib/kuwo"
)

type searchRequest struct {
	Keyword string `json:"keyword"`
	Source  string `json:"source"`
	Limit   int    `json:"limit"`
}

type candidate struct {
	Source         string            `json:"source"`
	ProviderTrackID string           `json:"providerTrackId"`
	Title          string            `json:"title"`
	Artist         string            `json:"artist"`
	Album          string            `json:"album"`
	Duration       int               `json:"duration"`
	CoverURL       string            `json:"coverUrl"`
	Link           string            `json:"link"`
	Ext            string            `json:"ext"`
	Extra          map[string]string `json:"extra,omitempty"`
}

type resolveRequest struct {
	Source    string    `json:"source"`
	Candidate candidate `json:"candidate"`
}

type resolveResponse struct {
	Source          string            `json:"source"`
	ProviderTrackID string            `json:"providerTrackId"`
	Title           string            `json:"title"`
	Artist          string            `json:"artist"`
	Album           string            `json:"album"`
	Duration        int               `json:"duration"`
	CoverURL        string            `json:"coverUrl"`
	RemoteURL       string            `json:"remoteUrl"`
	MimeType        string            `json:"mimeType"`
	Ext             string            `json:"ext"`
	Lyrics          string            `json:"lyrics"`
	Extra           map[string]string `json:"extra,omitempty"`
}

var supportedSources = []string{"qq", "kugou", "migu", "kuwo", "netease", "bilibili", "jamendo"}

var musicProviders map[string]provider.MusicProvider

func main() {
	loadDotEnvFile(".env")
	initProviders()

	addr := strings.TrimSpace(os.Getenv("MUSIC_LIB_BRIDGE_ADDR"))
	if addr == "" {
		port := strings.TrimSpace(os.Getenv("MUSIC_LIB_BRIDGE_PORT"))
		if port == "" {
			port = "46231"
		}
		addr = "127.0.0.1:" + port
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/search", handleSearch)
	mux.HandleFunc("/resolve", handleResolve)

	log.Printf("[music-lib-bridge] listening on %s", addr)
	if err := http.ListenAndServe(addr, withJSONHeaders(mux)); err != nil {
		log.Fatal(err)
	}
}

func initProviders() {
	musicProviders = map[string]provider.MusicProvider{
		"qq":       qq.New(strings.TrimSpace(os.Getenv("QQ_COOKIE"))),
		"kugou":    kugou.New(strings.TrimSpace(os.Getenv("KUGOU_COOKIE"))),
		"migu":     migu.New(strings.TrimSpace(os.Getenv("MIGU_COOKIE"))),
		"kuwo":     kuwo.New(strings.TrimSpace(os.Getenv("KUWO_COOKIE"))),
		"netease":  netease.New(strings.TrimSpace(os.Getenv("NETEASE_COOKIE"))),
		"bilibili": bilibili.New(strings.TrimSpace(os.Getenv("BILIBILI_COOKIE"))),
		"jamendo":  jamendo.New(strings.TrimSpace(os.Getenv("JAMENDO_COOKIE"))),
	}
}

func getProvider(source string) (provider.MusicProvider, error) {
	if musicProviders == nil {
		initProviders()
	}
	providerInstance, ok := musicProviders[source]
	if !ok || providerInstance == nil {
		return nil, fmt.Errorf("unsupported source: %s", source)
	}
	return providerInstance, nil
}

func withJSONHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"version": "1",
		"sources": supportedSources,
	})
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req searchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Source = strings.TrimSpace(strings.ToLower(req.Source))
	req.Keyword = strings.TrimSpace(req.Keyword)
	if req.Keyword == "" || req.Source == "" {
		writeError(w, http.StatusBadRequest, "source and keyword are required")
		return
	}
	if req.Limit <= 0 || req.Limit > 12 {
		req.Limit = 8
	}

	songs, err := searchSongs(req.Source, req.Keyword)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	items := make([]candidate, 0, min(req.Limit, len(songs)))
	for _, song := range songs {
		items = append(items, toCandidate(song))
		if len(items) >= req.Limit {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"source":     req.Source,
		"candidates": items,
	})
}

func handleResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req resolveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Source = strings.TrimSpace(strings.ToLower(req.Source))
	if req.Source == "" {
		req.Source = strings.TrimSpace(strings.ToLower(req.Candidate.Source))
	}
	if req.Source == "" || strings.TrimSpace(req.Candidate.ProviderTrackID) == "" {
		writeError(w, http.StatusBadRequest, "source and candidate.providerTrackId are required")
		return
	}

	song := fromCandidate(req.Candidate, req.Source)
	url, err := resolveDownloadURL(req.Source, song)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	lyrics, _ := resolveLyrics(req.Source, song)
	writeJSON(w, http.StatusOK, resolveResponse{
		Source:          req.Source,
		ProviderTrackID: req.Candidate.ProviderTrackID,
		Title:           song.Name,
		Artist:          song.Artist,
		Album:           song.Album,
		Duration:        song.Duration,
		CoverURL:        song.Cover,
		RemoteURL:       url,
		MimeType:        guessMime(url, req.Candidate.Ext),
		Ext:             firstNonEmpty(req.Candidate.Ext, song.Ext, extFromURL(url)),
		Lyrics:          lyrics,
		Extra:           req.Candidate.Extra,
	})
}

func searchSongs(source, keyword string) ([]model.Song, error) {
	providerInstance, err := getProvider(source)
	if err != nil {
		return nil, err
	}
	return providerInstance.Search(keyword)
}

func resolveDownloadURL(source string, song *model.Song) (string, error) {
	if strings.TrimSpace(song.URL) != "" {
		return song.URL, nil
	}
	providerInstance, err := getProvider(source)
	if err != nil {
		return "", err
	}
	return providerInstance.GetDownloadURL(song)
}

func resolveLyrics(source string, song *model.Song) (string, error) {
	providerInstance, err := getProvider(source)
	if err != nil {
		return "", errors.New("lyrics unsupported")
	}
	return providerInstance.GetLyrics(song)
}

func toCandidate(song model.Song) candidate {
	return candidate{
		Source:          song.Source,
		ProviderTrackID: firstNonEmpty(song.ID, song.Extra["track_id"], song.Extra["songmid"], song.Extra["rid"], song.Extra["content_id"]),
		Title:           song.Name,
		Artist:          song.Artist,
		Album:           song.Album,
		Duration:        song.Duration,
		CoverURL:        song.Cover,
		Link:            song.Link,
		Ext:             song.Ext,
		Extra:           song.Extra,
	}
}

func fromCandidate(item candidate, source string) *model.Song {
	trackID := strings.TrimSpace(item.ProviderTrackID)
	if trackID == "" {
		trackID = firstNonEmpty(item.Extra["track_id"], item.Extra["songmid"], item.Extra["rid"], item.Extra["content_id"], item.Title)
	}
	return &model.Song{
		Source:   source,
		ID:       trackID,
		Name:     item.Title,
		Artist:   item.Artist,
		Album:    item.Album,
		Duration: item.Duration,
		Cover:    item.CoverURL,
		Link:     item.Link,
		Ext:      item.Ext,
		Extra:    item.Extra,
	}
}

func guessMime(urlValue, extValue string) string {
	ext := firstNonEmpty(extValue, extFromURL(urlValue))
	if ext == "" {
		return "audio/mpeg"
	}
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		if strings.EqualFold(ext, ".m4a") || strings.EqualFold(ext, ".m4s") {
			return "audio/mp4"
		}
		return "audio/mpeg"
	}
	return mimeType
}

func extFromURL(urlValue string) string {
	urlValue = strings.TrimSpace(urlValue)
	if urlValue == "" {
		return ""
	}
	withoutQuery := strings.Split(strings.Split(urlValue, "?" )[0], "#")[0]
	ext := path.Ext(withoutQuery)
	if ext == "" {
		return ""
	}
	return strings.ToLower(ext)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func init() {
	if value := strings.TrimSpace(os.Getenv("MUSIC_LIB_BRIDGE_PORT")); value != "" {
		if _, err := strconv.Atoi(value); err != nil {
			log.Printf("[music-lib-bridge] invalid MUSIC_LIB_BRIDGE_PORT: %s", value)
		}
	}
}

func loadDotEnvFile(filePath string) {
	body, err := os.ReadFile(filePath)
	if err != nil {
		return
	}
	for _, rawLine := range strings.Split(string(body), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		separator := strings.Index(line, "=")
		if separator <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:separator])
		if key == "" || os.Getenv(key) != "" {
			continue
		}
		value := strings.TrimSpace(line[separator+1:])
		if unquoted, unquoteErr := strconv.Unquote(value); unquoteErr == nil {
			value = unquoted
		}
		_ = os.Setenv(key, value)
	}
}
