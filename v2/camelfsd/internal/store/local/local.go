package local

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "github.com/mattn/go-sqlite3"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
)

type LocalStore struct {
	dataDir string
	objDir  string
	db      *sql.DB
	writeMu sync.Mutex
}

func Open(dataDir string) (*LocalStore, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir data dir: %w", err)
	}
	objDir := filepath.Join(dataDir, "objects")
	if err := os.MkdirAll(objDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir objects dir: %w", err)
	}
	dbPath := filepath.Join(dataDir, "camelfs.sqlite")
	dsn := fmt.Sprintf("file:%s?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on", dbPath)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)

	s := &LocalStore{
		dataDir: dataDir,
		objDir:  objDir,
		db:      db,
	}
	if err := s.initSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *LocalStore) Close() error {
	return s.db.Close()
}

func (s *LocalStore) initSchema() error {
	schema := `
CREATE TABLE IF NOT EXISTS lineages (
	lineage TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL,
	default_ref TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refs (
	lineage TEXT NOT NULL,
	name TEXT NOT NULL,
	commit_hash TEXT NOT NULL,
	tree_hash TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	lease_holder TEXT NOT NULL DEFAULT '',
	lease_epoch INTEGER NOT NULL DEFAULT 0,
	lease_expires_at INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (lineage, name)
);

CREATE TABLE IF NOT EXISTS lineage_objects (
	lineage TEXT NOT NULL,
	hash TEXT NOT NULL,
	PRIMARY KEY (lineage, hash)
);
CREATE INDEX IF NOT EXISTS idx_lineage_objects_hash ON lineage_objects(hash);

CREATE TABLE IF NOT EXISTS vms (
	vm_id TEXT PRIMARY KEY,
	lineage TEXT NOT NULL,
	ref_name TEXT NOT NULL,
	holder TEXT NOT NULL,
	lease_epoch INTEGER NOT NULL,
	state TEXT NOT NULL,
	head_commit TEXT NOT NULL,
	vcpus INTEGER NOT NULL,
	memory_mib INTEGER NOT NULL,
	idle_timeout_s INTEGER NOT NULL,
	env_json TEXT NOT NULL,
	host_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_active_at INTEGER NOT NULL,
	lease_expires_at INTEGER NOT NULL,
	total_duration_ms INTEGER NOT NULL,
	billed_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vms_lineage_ref_state ON vms(lineage, ref_name, state);

CREATE TABLE IF NOT EXISTS exec_receipts (
	vm_id TEXT NOT NULL,
	exec_id TEXT NOT NULL,
	response_json BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (vm_id, exec_id)
);

CREATE TABLE IF NOT EXISTS hosts (
	host_id TEXT PRIMARY KEY,
	address TEXT NOT NULL,
	capacity_vms INTEGER NOT NULL,
	running_vms INTEGER NOT NULL,
	status TEXT NOT NULL,
	labels_json TEXT NOT NULL,
	last_heartbeat_at INTEGER NOT NULL
);
`
	_, err := s.db.Exec(schema)
	if err != nil {
		return fmt.Errorf("init sqlite schema: %w", err)
	}
	return nil
}

func (s *LocalStore) objectPath(hash string) string {
	prefix := "00"
	if len(hash) >= 2 {
		prefix = hash[:2]
	}
	return filepath.Join(s.objDir, prefix, hash)
}

func (s *LocalStore) PutObject(ctx context.Context, lineage string, kind store.ObjectKind, data []byte) (string, error) {
	hash := store.HashObject(kind, data)
	dst := s.objectPath(hash)

	if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
		packed, err := store.PackObject(kind, data)
		if err != nil {
			return "", apperr.Internal("compress object", err)
		}
		dir := filepath.Dir(dst)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", apperr.Internal("mkdir object prefix", err)
		}
		tmp, err := os.CreateTemp(dir, ".obj-*")
		if err != nil {
			return "", apperr.Internal("create temp object", err)
		}
		tmpName := tmp.Name()
		if _, err := tmp.Write(packed); err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
			return "", apperr.Internal("write temp object", err)
		}
		if err := tmp.Close(); err != nil {
			_ = os.Remove(tmpName)
			return "", apperr.Internal("close temp object", err)
		}
		if err := os.Rename(tmpName, dst); err != nil {
			_ = os.Remove(tmpName)
			return "", apperr.Internal("rename object", err)
		}
	}

	if lineage != "" {
		if err := s.LinkObjects(ctx, lineage, []string{hash}); err != nil {
			return "", err
		}
	}
	return hash, nil
}

func (s *LocalStore) GetObject(_ context.Context, hash string) (store.ObjectKind, []byte, error) {
	if len(hash) < 4 {
		return "", nil, apperr.NotFoundf("object %q not found", hash)
	}
	raw, err := os.ReadFile(s.objectPath(hash))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil, apperr.NotFoundf("object %q not found", hash)
		}
		return "", nil, apperr.Internal("read object", err)
	}
	kind, data, err := store.UnpackObject(raw)
	if err != nil {
		return "", nil, apperr.Internal("unpack object", err)
	}
	return kind, data, nil
}

func (s *LocalStore) HasObject(_ context.Context, hash string) (bool, error) {
	if len(hash) < 4 {
		return false, nil
	}
	_, err := os.Stat(s.objectPath(hash))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, apperr.Internal("stat object", err)
}

func (s *LocalStore) LinkObjects(ctx context.Context, lineage string, hashes []string) error {
	if lineage == "" || len(hashes) == 0 {
		return nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return apperr.Internal("begin link objects tx", err)
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO lineage_objects(lineage, hash) VALUES (?, ?)`)
	if err != nil {
		return apperr.Internal("prepare link objects", err)
	}
	defer stmt.Close()

	for _, h := range hashes {
		if h == "" {
			continue
		}
		if _, err := stmt.ExecContext(ctx, lineage, h); err != nil {
			return apperr.Internal("insert lineage object", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return apperr.Internal("commit link objects", err)
	}
	return nil
}

func (s *LocalStore) CreateLineageIfAbsent(
	ctx context.Context,
	lin store.LineageRecord,
	initRef store.RefRecord,
) (store.LineageRecord, store.RefRecord, bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return store.LineageRecord{}, store.RefRecord{}, false, apperr.Internal("begin tx", err)
	}
	defer func() { _ = tx.Rollback() }()

	var existing store.LineageRecord
	err = tx.QueryRowContext(
		ctx,
		`SELECT lineage, tenant_id, default_ref, created_at FROM lineages WHERE lineage = ?`,
		lin.Lineage,
	).Scan(&existing.Lineage, &existing.TenantID, &existing.DefaultRef, &existing.CreatedAt)
	if err == nil {
		var r store.RefRecord
		err = tx.QueryRowContext(
			ctx,
			`SELECT name, commit_hash, tree_hash, updated_at FROM refs WHERE lineage = ? AND name = ?`,
			existing.Lineage, existing.DefaultRef,
		).Scan(&r.Name, &r.Commit, &r.Tree, &r.UpdatedAt)
		if err != nil {
			return store.LineageRecord{}, store.RefRecord{}, false, apperr.Internal("query default ref", err)
		}
		r.Lineage = existing.Lineage
		return existing, r, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return store.LineageRecord{}, store.RefRecord{}, false, apperr.Internal("query lineage", err)
	}

	_, err = tx.ExecContext(
		ctx,
		`INSERT INTO lineages(lineage, tenant_id, default_ref, created_at) VALUES (?, ?, ?, ?)`,
		lin.Lineage, lin.TenantID, lin.DefaultRef, lin.CreatedAt,
	)
	if err != nil {
		return store.LineageRecord{}, store.RefRecord{}, false, apperr.Internal("insert lineage", err)
	}

	_, err = tx.ExecContext(
		ctx,
		`INSERT INTO refs(lineage, name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at)
		 VALUES (?, ?, ?, ?, ?, '', 0, 0)`,
		lin.Lineage, initRef.Name, initRef.Commit, initRef.Tree, initRef.UpdatedAt,
	)
	if err != nil {
		return store.LineageRecord{}, store.RefRecord{}, false, apperr.Internal("insert initial ref", err)
	}

	if err := tx.Commit(); err != nil {
		return store.LineageRecord{}, store.RefRecord{}, false, apperr.Internal("commit create lineage", err)
	}
	initRef.Lineage = lin.Lineage
	return lin, initRef, true, nil
}

func (s *LocalStore) GetLineage(ctx context.Context, lineage string) (*store.LineageRecord, error) {
	var rec store.LineageRecord
	err := s.db.QueryRowContext(
		ctx,
		`SELECT lineage, tenant_id, default_ref, created_at FROM lineages WHERE lineage = ?`,
		lineage,
	).Scan(&rec.Lineage, &rec.TenantID, &rec.DefaultRef, &rec.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFoundf("lineage %q not found", lineage)
	}
	if err != nil {
		return nil, apperr.Internal("get lineage", err)
	}
	return &rec, nil
}

func (s *LocalStore) DeleteLineage(ctx context.Context, lineage string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return apperr.Internal("begin delete lineage tx", err)
	}
	defer func() { _ = tx.Rollback() }()

	var exists string
	err = tx.QueryRowContext(ctx, `SELECT lineage FROM lineages WHERE lineage = ?`, lineage).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.NotFoundf("lineage %q not found", lineage)
	}
	if err != nil {
		return apperr.Internal("check lineage", err)
	}

	// Collect hashes associated with this lineage before deleting links.
	rows, err := tx.QueryContext(ctx, `SELECT hash FROM lineage_objects WHERE lineage = ?`, lineage)
	if err != nil {
		return apperr.Internal("list lineage objects", err)
	}
	var candidateHashes []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			rows.Close()
			return apperr.Internal("scan lineage object", err)
		}
		candidateHashes = append(candidateHashes, h)
	}
	rows.Close()

	if _, err := tx.ExecContext(ctx, `DELETE FROM exec_receipts WHERE vm_id IN (SELECT vm_id FROM vms WHERE lineage = ?)`, lineage); err != nil {
		return apperr.Internal("delete exec receipts", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM vms WHERE lineage = ?`, lineage); err != nil {
		return apperr.Internal("delete lineage vms", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM refs WHERE lineage = ?`, lineage); err != nil {
		return apperr.Internal("delete lineage refs", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM lineage_objects WHERE lineage = ?`, lineage); err != nil {
		return apperr.Internal("delete lineage object links", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM lineages WHERE lineage = ?`, lineage); err != nil {
		return apperr.Internal("delete lineage record", err)
	}

	// Determine which objects are now completely unreferenced by any lineage.
	var unreferenced []string
	if len(candidateHashes) > 0 {
		chk, err := tx.PrepareContext(ctx, `SELECT 1 FROM lineage_objects WHERE hash = ? LIMIT 1`)
		if err != nil {
			return apperr.Internal("prepare unref check", err)
		}
		for _, h := range candidateHashes {
			var one int
			err := chk.QueryRowContext(ctx, h).Scan(&one)
			if errors.Is(err, sql.ErrNoRows) {
				unreferenced = append(unreferenced, h)
			}
		}
		chk.Close()
	}

	if err := tx.Commit(); err != nil {
		return apperr.Internal("commit delete lineage", err)
	}

	for _, h := range unreferenced {
		_ = os.Remove(s.objectPath(h))
	}
	return nil
}

func scanRefRow(lineage, name, commit, tree string, updatedAt int64, holder string, epoch, expiresAt, nowMs int64) store.RefRecord {
	rec := store.RefRecord{
		Lineage:   lineage,
		Name:      name,
		Commit:    commit,
		Tree:      tree,
		UpdatedAt: updatedAt,
	}
	if holder != "" && expiresAt > nowMs {
		rec.Lease = &store.Lease{
			Holder:    holder,
			Epoch:     epoch,
			ExpiresAt: expiresAt,
		}
	}
	return rec
}

func (s *LocalStore) GetRef(ctx context.Context, lineage, ref string, nowMs int64) (*store.RefRecord, error) {
	var (
		name, commit, tree, holder  string
		updatedAt, epoch, expiresAt int64
	)
	err := s.db.QueryRowContext(
		ctx,
		`SELECT name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at
		 FROM refs WHERE lineage = ? AND name = ?`,
		lineage, ref,
	).Scan(&name, &commit, &tree, &updatedAt, &holder, &epoch, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFoundf("ref %q not found in lineage %q", ref, lineage)
	}
	if err != nil {
		return nil, apperr.Internal("get ref", err)
	}
	rec := scanRefRow(lineage, name, commit, tree, updatedAt, holder, epoch, expiresAt, nowMs)
	return &rec, nil
}

func (s *LocalStore) ListRefs(ctx context.Context, lineage, prefix string, nowMs int64) ([]store.RefRecord, error) {
	if _, err := s.GetLineage(ctx, lineage); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at
		 FROM refs WHERE lineage = ? AND name LIKE ? ORDER BY name ASC`,
		lineage, prefix+"%",
	)
	if err != nil {
		return nil, apperr.Internal("list refs", err)
	}
	defer rows.Close()

	out := make([]store.RefRecord, 0)
	for rows.Next() {
		var (
			name, commit, tree, holder  string
			updatedAt, epoch, expiresAt int64
		)
		if err := rows.Scan(&name, &commit, &tree, &updatedAt, &holder, &epoch, &expiresAt); err != nil {
			return nil, apperr.Internal("scan ref", err)
		}
		out = append(out, scanRefRow(lineage, name, commit, tree, updatedAt, holder, epoch, expiresAt, nowMs))
	}
	return out, nil
}

func (s *LocalStore) SetRef(ctx context.Context, p store.SetRefParams) (*store.RefRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, apperr.Internal("begin set ref tx", err)
	}
	defer func() { _ = tx.Rollback() }()

	var exists string
	err = tx.QueryRowContext(ctx, `SELECT lineage FROM lineages WHERE lineage = ?`, p.Lineage).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFoundf("lineage %q not found", p.Lineage)
	}
	if err != nil {
		return nil, apperr.Internal("check lineage", err)
	}

	var (
		curCommit, curTree, curHolder   string
		curUpdated, curEpoch, curExpiry int64
		refFound                        = true
	)
	err = tx.QueryRowContext(
		ctx,
		`SELECT commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at
		 FROM refs WHERE lineage = ? AND name = ?`,
		p.Lineage, p.Ref,
	).Scan(&curCommit, &curTree, &curUpdated, &curHolder, &curEpoch, &curExpiry)
	if errors.Is(err, sql.ErrNoRows) {
		refFound = false
	} else if err != nil {
		return nil, apperr.Internal("read ref for update", err)
	}

	if refFound {
		// Enforce lease check if active.
		if curHolder != "" && curExpiry > p.NowMs {
			if p.Holder != curHolder {
				return nil, apperr.RefLeasedf("ref %q is leased by %q", p.Ref, curHolder)
			}
			if p.ExpectedEpoch > 0 && curEpoch != p.ExpectedEpoch {
				return nil, apperr.RefLeasedf("stale lease epoch %d on ref %q (current %d)", p.ExpectedEpoch, p.Ref, curEpoch)
			}
		}
		if p.ExpectedCommit != "" && curCommit != p.ExpectedCommit {
			return nil, apperr.CASConflictf("expected commit %q on ref %q, got %q", p.ExpectedCommit, p.Ref, curCommit)
		}
	} else {
		if p.ExpectedCommit != "" {
			return nil, apperr.CASConflictf("expected commit %q on missing ref %q", p.ExpectedCommit, p.Ref)
		}
		if p.Delete {
			return nil, apperr.NotFoundf("ref %q not found", p.Ref)
		}
	}

	if p.Delete {
		if _, err := tx.ExecContext(ctx, `DELETE FROM refs WHERE lineage = ? AND name = ?`, p.Lineage, p.Ref); err != nil {
			return nil, apperr.Internal("delete ref", err)
		}
		if err := tx.Commit(); err != nil {
			return nil, apperr.Internal("commit delete ref", err)
		}
		return &store.RefRecord{
			Lineage:   p.Lineage,
			Name:      p.Ref,
			Commit:    "",
			Tree:      "",
			UpdatedAt: p.NowMs,
		}, nil
	}

	if refFound {
		_, err = tx.ExecContext(
			ctx,
			`UPDATE refs SET commit_hash = ?, tree_hash = ?, updated_at = ? WHERE lineage = ? AND name = ?`,
			p.Commit, p.Tree, p.NowMs, p.Lineage, p.Ref,
		)
	} else {
		_, err = tx.ExecContext(
			ctx,
			`INSERT INTO refs(lineage, name, commit_hash, tree_hash, updated_at, lease_holder, lease_epoch, lease_expires_at)
			 VALUES (?, ?, ?, ?, ?, '', 0, 0)`,
			p.Lineage, p.Ref, p.Commit, p.Tree, p.NowMs,
		)
	}
	if err != nil {
		return nil, apperr.Internal("write ref", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, apperr.Internal("commit set ref", err)
	}

	rec := scanRefRow(p.Lineage, p.Ref, p.Commit, p.Tree, p.NowMs, curHolder, curEpoch, curExpiry, p.NowMs)
	return &rec, nil
}

func (s *LocalStore) LeaseRef(ctx context.Context, p store.LeaseRefParams) (*store.LeaseResult, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, apperr.Internal("begin lease tx", err)
	}
	defer func() { _ = tx.Rollback() }()

	var (
		commit, tree, curHolder string
		curEpoch, curExpiry     int64
	)
	err = tx.QueryRowContext(
		ctx,
		`SELECT commit_hash, tree_hash, lease_holder, lease_epoch, lease_expires_at
		 FROM refs WHERE lineage = ? AND name = ?`,
		p.Lineage, p.Ref,
	).Scan(&commit, &tree, &curHolder, &curEpoch, &curExpiry)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFoundf("ref %q not found in lineage %q", p.Ref, p.Lineage)
	}
	if err != nil {
		return nil, apperr.Internal("query ref for lease", err)
	}

	if p.Release && p.ExpectedEpoch > 0 && (curHolder != p.Holder || curEpoch != p.ExpectedEpoch) {
		return &store.LeaseResult{Ref: p.Ref, Commit: commit, Tree: tree, Holder: curHolder, Epoch: curEpoch, ExpiresAt: curExpiry}, nil
	}
	if curHolder != "" && curExpiry > p.NowMs && curHolder != p.Holder {
		return nil, apperr.RefLeasedf("ref %q is currently leased by %q", p.Ref, curHolder)
	}

	if p.Release {
		_, err = tx.ExecContext(
			ctx,
			`UPDATE refs SET lease_holder = '', lease_expires_at = 0 WHERE lineage = ? AND name = ?`,
			p.Lineage, p.Ref,
		)
		if err != nil {
			return nil, apperr.Internal("release lease", err)
		}
		if err := tx.Commit(); err != nil {
			return nil, apperr.Internal("commit release lease", err)
		}
		return &store.LeaseResult{
			Ref:       p.Ref,
			Commit:    commit,
			Tree:      tree,
			Holder:    "",
			Epoch:     curEpoch,
			ExpiresAt: 0,
		}, nil
	}

	newEpoch := curEpoch + 1
	newExpiry := p.NowMs + p.TTLMs
	_, err = tx.ExecContext(
		ctx,
		`UPDATE refs SET lease_holder = ?, lease_epoch = ?, lease_expires_at = ? WHERE lineage = ? AND name = ?`,
		p.Holder, newEpoch, newExpiry, p.Lineage, p.Ref,
	)
	if err != nil {
		return nil, apperr.Internal("acquire lease", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, apperr.Internal("commit acquire lease", err)
	}

	return &store.LeaseResult{
		Ref:       p.Ref,
		Commit:    commit,
		Tree:      tree,
		Holder:    p.Holder,
		Epoch:     newEpoch,
		ExpiresAt: newExpiry,
	}, nil
}

func scanVM(scanner interface{ Scan(dest ...any) error }) (*store.VMRecord, error) {
	var (
		vm      store.VMRecord
		envJSON string
	)
	err := scanner.Scan(
		&vm.VMID,
		&vm.Lineage,
		&vm.Ref,
		&vm.Holder,
		&vm.LeaseEpoch,
		&vm.State,
		&vm.HeadCommit,
		&vm.VCPUs,
		&vm.MemoryMiB,
		&vm.IdleTimeoutS,
		&envJSON,
		&vm.HostID,
		&vm.CreatedAt,
		&vm.LastActiveAt,
		&vm.LeaseExpiresAt,
		&vm.TotalDurationMs,
		&vm.BilledMs,
	)
	if err != nil {
		return nil, err
	}
	if envJSON != "" {
		_ = json.Unmarshal([]byte(envJSON), &vm.Env)
	}
	if vm.Env == nil {
		vm.Env = map[string]string{}
	}
	return &vm, nil
}

const vmColumns = `vm_id, lineage, ref_name, holder, lease_epoch, state, head_commit, vcpus, memory_mib, idle_timeout_s, env_json, host_id, created_at, last_active_at, lease_expires_at, total_duration_ms, billed_ms`

func (s *LocalStore) GetRunningVMByRef(ctx context.Context, lineage, ref string) (*store.VMRecord, error) {
	row := s.db.QueryRowContext(
		ctx,
		`SELECT `+vmColumns+` FROM vms WHERE lineage = ? AND ref_name = ? AND state = 'running' LIMIT 1`,
		lineage, ref,
	)
	vm, err := scanVM(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, apperr.Internal("get running vm by ref", err)
	}
	return vm, nil
}

func (s *LocalStore) ListRunningVMs(ctx context.Context, _ bool) ([]*store.VMRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+vmColumns+` FROM vms WHERE state = 'running'`)
	if err != nil {
		return nil, apperr.Internal("list running vms", err)
	}
	defer rows.Close()

	var out []*store.VMRecord
	for rows.Next() {
		vm, err := scanVM(rows)
		if err != nil {
			return nil, apperr.Internal("scan running vm", err)
		}
		out = append(out, vm)
	}
	return out, nil
}

func (s *LocalStore) ListRunningVMsByLineage(ctx context.Context, lineage string) ([]*store.VMRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+vmColumns+` FROM vms WHERE lineage = ? AND state = 'running'`, lineage)
	if err != nil {
		return nil, apperr.Internal("list lineage vms", err)
	}
	defer rows.Close()

	var out []*store.VMRecord
	for rows.Next() {
		vm, err := scanVM(rows)
		if err != nil {
			return nil, apperr.Internal("scan lineage vm", err)
		}
		out = append(out, vm)
	}
	return out, nil
}

func (s *LocalStore) CreateRunningVM(ctx context.Context, vm *store.VMRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return apperr.Internal("begin create vm tx", err)
	}
	defer func() { _ = tx.Rollback() }()

	var existingID, existingHolder string
	err = tx.QueryRowContext(
		ctx,
		`SELECT vm_id, holder FROM vms WHERE lineage = ? AND ref_name = ? AND state = 'running' LIMIT 1`,
		vm.Lineage, vm.Ref,
	).Scan(&existingID, &existingHolder)
	if err == nil {
		return apperr.RefLeasedf("running VM %q already exists on (%s, %s) held by %q", existingID, vm.Lineage, vm.Ref, existingHolder)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return apperr.Internal("check existing running vm", err)
	}

	envBytes, _ := json.Marshal(vm.Env)
	_, err = tx.ExecContext(
		ctx,
		`INSERT INTO vms(`+vmColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		vm.VMID,
		vm.Lineage,
		vm.Ref,
		vm.Holder,
		vm.LeaseEpoch,
		vm.State,
		vm.HeadCommit,
		vm.VCPUs,
		vm.MemoryMiB,
		vm.IdleTimeoutS,
		string(envBytes),
		vm.HostID,
		vm.CreatedAt,
		vm.LastActiveAt,
		vm.LeaseExpiresAt,
		vm.TotalDurationMs,
		vm.BilledMs,
	)
	if err != nil {
		return apperr.Internal("insert vm", err)
	}
	if err := tx.Commit(); err != nil {
		return apperr.Internal("commit create vm", err)
	}
	return nil
}

func (s *LocalStore) GetVM(ctx context.Context, vmID string) (*store.VMRecord, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+vmColumns+` FROM vms WHERE vm_id = ?`, vmID)
	vm, err := scanVM(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFoundf("vm %q not found", vmID)
	}
	if err != nil {
		return nil, apperr.Internal("get vm", err)
	}
	return vm, nil
}

func (s *LocalStore) UpdateVM(ctx context.Context, vm *store.VMRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	envBytes, _ := json.Marshal(vm.Env)
	res, err := s.db.ExecContext(
		ctx,
		`UPDATE vms SET
			holder = ?, lease_epoch = ?, state = ?, head_commit = ?, idle_timeout_s = ?, host_id = ?,
			last_active_at = ?, lease_expires_at = ?, total_duration_ms = ?, billed_ms = ?, env_json = ?
		 WHERE vm_id = ?`,
		vm.Holder,
		vm.LeaseEpoch,
		vm.State,
		vm.HeadCommit,
		vm.IdleTimeoutS,
		vm.HostID,
		vm.LastActiveAt,
		vm.LeaseExpiresAt,
		vm.TotalDurationMs,
		vm.BilledMs,
		string(envBytes),
		vm.VMID,
	)
	if err != nil {
		return apperr.Internal("update vm", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return apperr.NotFoundf("vm %q not found", vm.VMID)
	}
	return nil
}

func (s *LocalStore) GetExecReceipt(ctx context.Context, vmID, execID string) (*store.ExecReceipt, error) {
	var r store.ExecReceipt
	err := s.db.QueryRowContext(
		ctx,
		`SELECT vm_id, exec_id, response_json, created_at FROM exec_receipts WHERE vm_id = ? AND exec_id = ?`,
		vmID, execID,
	).Scan(&r.VMID, &r.ExecID, &r.ResponseJSON, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, apperr.Internal("get exec receipt", err)
	}
	return &r, nil
}

func (s *LocalStore) PutExecReceipt(ctx context.Context, r *store.ExecReceipt) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	_, err := s.db.ExecContext(
		ctx,
		`INSERT OR REPLACE INTO exec_receipts(vm_id, exec_id, response_json, created_at) VALUES (?, ?, ?, ?)`,
		r.VMID, r.ExecID, r.ResponseJSON, r.CreatedAt,
	)
	if err != nil {
		return apperr.Internal("put exec receipt", err)
	}
	return nil
}

func (s *LocalStore) UpsertHost(ctx context.Context, h *store.HostRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	labelsBytes, _ := json.Marshal(h.Labels)
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO hosts(host_id, address, capacity_vms, running_vms, status, labels_json, last_heartbeat_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(host_id) DO UPDATE SET
			address = excluded.address,
			capacity_vms = excluded.capacity_vms,
			running_vms = excluded.running_vms,
			status = excluded.status,
			labels_json = excluded.labels_json,
			last_heartbeat_at = excluded.last_heartbeat_at`,
		h.HostID, h.Address, h.CapacityVMs, h.RunningVMs, h.Status, string(labelsBytes), h.LastHeartbeatAt,
	)
	if err != nil {
		return apperr.Internal("upsert host", err)
	}
	return nil
}

func (s *LocalStore) GetHost(ctx context.Context, hostID string) (*store.HostRecord, error) {
	var (
		h          store.HostRecord
		labelsJSON string
	)
	err := s.db.QueryRowContext(
		ctx,
		`SELECT host_id, address, capacity_vms, running_vms, status, labels_json, last_heartbeat_at FROM hosts WHERE host_id = ?`,
		hostID,
	).Scan(&h.HostID, &h.Address, &h.CapacityVMs, &h.RunningVMs, &h.Status, &labelsJSON, &h.LastHeartbeatAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFoundf("host %q not found", hostID)
	}
	if err != nil {
		return nil, apperr.Internal("get host", err)
	}
	if labelsJSON != "" {
		_ = json.Unmarshal([]byte(labelsJSON), &h.Labels)
	}
	return &h, nil
}

func (s *LocalStore) ListHosts(ctx context.Context) ([]*store.HostRecord, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT host_id, address, capacity_vms, running_vms, status, labels_json, last_heartbeat_at FROM hosts ORDER BY host_id ASC`,
	)
	if err != nil {
		return nil, apperr.Internal("list hosts", err)
	}
	defer rows.Close()

	var out []*store.HostRecord
	for rows.Next() {
		var (
			h          store.HostRecord
			labelsJSON string
		)
		if err := rows.Scan(&h.HostID, &h.Address, &h.CapacityVMs, &h.RunningVMs, &h.Status, &labelsJSON, &h.LastHeartbeatAt); err != nil {
			return nil, apperr.Internal("scan host", err)
		}
		if labelsJSON != "" {
			_ = json.Unmarshal([]byte(labelsJSON), &h.Labels)
		}
		out = append(out, &h)
	}
	return out, nil
}
