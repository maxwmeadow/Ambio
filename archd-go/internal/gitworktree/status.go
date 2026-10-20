package gitworktree

import (
	"bytes"
	"strconv"
	"strings"
)

// Status is what a checkout has not committed, and how its branch stands
// against its upstream.
type Status struct {
	// ChangedFiles counts staged, unstaged and untracked paths in the folder.
	ChangedFiles int
	Upstream     string
	Ahead        int
	Behind       int
}

// ReadStatus asks Git for a checkout's status, limited to path (which may be
// a folder inside the repository).
func ReadStatus(path string) (Status, error) {
	output, err := gitOutput(path, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--", ".")
	if err != nil {
		return Status{}, err
	}
	return parseStatus(output), nil
}

func parseStatus(output []byte) Status {
	var status Status
	fields := bytes.Split(output, []byte{0})
	for index := 0; index < len(fields); index++ {
		field := string(fields[index])
		switch {
		case strings.HasPrefix(field, "# branch.upstream "):
			status.Upstream = strings.TrimPrefix(field, "# branch.upstream ")
		case strings.HasPrefix(field, "# branch.ab "):
			for _, count := range strings.Fields(strings.TrimPrefix(field, "# branch.ab ")) {
				value, err := strconv.Atoi(strings.TrimLeft(count, "+-"))
				if err != nil {
					continue
				}
				if strings.HasPrefix(count, "+") {
					status.Ahead = value
				} else {
					status.Behind = value
				}
			}
		case strings.HasPrefix(field, "2 "):
			// A rename or copy is followed by its original path.
			status.ChangedFiles++
			index++
		case strings.HasPrefix(field, "1 "), strings.HasPrefix(field, "u "), strings.HasPrefix(field, "? "):
			status.ChangedFiles++
		}
	}
	return status
}
